import { z } from 'zod';

// Types for workflow data
interface FeedbackEntry {
	id: number;
	source: string;
	text: string;
	sentiment?: string;
	theme?: string;
	created_at: string;
}

interface Escalation {
	theme: string;
	score: number;
	problem_statement: string;
	evidence: string[] | Array<{ text: string; source: string }>;
	sentiment_distribution: { positive: number; neutral: number; negative: number };
	source_distribution: Record<string, number>;
	trend_direction: 'increasing' | 'decreasing' | 'stable';
	status?: string;
	notes?: string;
}

interface Env {
	pointer_db: D1Database;
	AI: any;
}

// Enhanced source weights for escalation scoring
const SOURCE_WEIGHTS: Record<string, number> = {
	support_ticket: 8,
	github_issue: 6,
	twitter: 4,
	community_forum: 2
};

// Enhanced sentiment weights
const SENTIMENT_WEIGHTS: Record<string, number> = {
	negative: 6,
	neutral: 3,
	positive: 1
};

// Recency weights (more recent = higher weight)
const RECENCY_WEIGHTS = {
	getWeight: (daysAgo: number) => {
		if (daysAgo <= 1) return 10;  // Today/today
		if (daysAgo <= 3) return 8;   // Last 3 days
		if (daysAgo <= 7) return 5;   // Last week
		if (daysAgo <= 14) return 3;  // Last 2 weeks
		return 1;                     // Older than 2 weeks
	}
};

// Severity keywords for additional scoring
const SEVERITY_KEYWORDS = [
	'critical', 'urgent', 'broken', 'crash', 'fail', 'error', 'bug', 'issue',
	'problem', 'down', 'unusable', 'cannot', 'unable', 'not working'
];

// Step 1: Process all feedback with AI analysis
async function processAllFeedback(env: Env): Promise<{ success: boolean; processed: number }> {
	try {
		const feedback = await env.pointer_db.prepare('SELECT id, text FROM feedback WHERE sentiment IS NULL').all() as { results: { id: number; text: string }[] };
		
		for (const entry of feedback.results) {
			try {
				// Truncate text for AI processing
				const truncatedText = entry.text.length > 200 ? entry.text.substring(0, 200) + '...' : entry.text;
				
				// AI analysis for sentiment and theme
				const aiResponse = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
					prompt: `Analyze this feedback for sentiment and theme. Respond with JSON only:
{
  "sentiment": "positive|neutral|negative",
  "theme": "performance|ui|security|documentation|feature_request|bug|general|pricing|integration|other"
}

Feedback: "${truncatedText}"`
				});

				let sentiment = 'neutral';
				let theme = 'general';
				
				try {
					const aiResult = JSON.parse(aiResponse.response);
					sentiment = aiResult.sentiment || 'neutral';
					theme = aiResult.theme || 'general';
				} catch (parseError) {
					console.error('AI response parsing failed:', parseError);
				}
				
				// Update feedback with AI analysis
				await env.pointer_db.prepare(
					'UPDATE feedback SET sentiment = ?, theme = ? WHERE id = ?'
				).bind(sentiment, theme, entry.id).run();
				
			} catch (error) {
				console.error(`Failed to process feedback ${entry.id}:`, error);
			}
		}
		
		return { success: true, processed: feedback.results.length };
	} catch (error) {
		console.error('Workflow feedback processing failed:', error);
		return { success: false, processed: 0 };
	}
}

// Step 2: Generate escalations from analyzed feedback
async function generateEscalations(env: Env): Promise<{ success: boolean; escalations: Escalation[] }> {
	try {
		// Get all feedback with AI analysis
		const feedback = await env.pointer_db.prepare(`
			SELECT source, text, sentiment, theme, created_at 
			FROM feedback 
			WHERE sentiment IS NOT NULL AND theme IS NOT NULL
			ORDER BY created_at DESC
		`).all() as { results: FeedbackEntry[] };

		// Group feedback by theme
		const themeGroups: Record<string, FeedbackEntry[]> = {};
		for (const entry of feedback.results) {
			const theme = entry.theme || 'general';
			if (!themeGroups[theme]) {
				themeGroups[theme] = [];
			}
			themeGroups[theme].push(entry);
		}

		const escalations: Escalation[] = [];

		// Process each theme group
		for (const [theme, entries] of Object.entries(themeGroups)) {
			if (entries.length < 2) continue; // Skip themes with less than 2 feedback entries

			// Calculate escalation score
			let score = 0;
			const sentimentDistribution = { positive: 0, neutral: 0, negative: 0 };
			const sourceDistribution: Record<string, number> = {};

			for (const entry of entries) {
				// Source weight
				const sourceWeight = SOURCE_WEIGHTS[entry.source] || 1;
				
				// Sentiment weight
				const sentimentWeight = SENTIMENT_WEIGHTS[entry.sentiment || 'neutral'] || 1;
				
				// Recency weight
				const daysAgo = Math.floor((Date.now() - new Date(entry.created_at).getTime()) / (1000 * 60 * 60 * 24));
				const recencyWeight = RECENCY_WEIGHTS.getWeight(daysAgo);
				
				// Severity bonus
				const text = entry.text.toLowerCase();
				const severityBonus = SEVERITY_KEYWORDS.some(keyword => text.includes(keyword)) ? 5 : 0;
				
				// Calculate entry score
				const entryScore = (sourceWeight * 0.3) + (sentimentWeight * 0.4) + (recencyWeight * 0.3) + severityBonus;
				score += entryScore;

				// Update distributions
				if (entry.sentiment) {
					sentimentDistribution[entry.sentiment as keyof typeof sentimentDistribution]++;
				}
				sourceDistribution[entry.source] = (sourceDistribution[entry.source] || 0) + 1;
			}

			// Normalize score by number of entries
			score = score / entries.length;

			// Generate problem statement using AI
			const problemStatement = await generateProblemStatement(theme, entries.slice(0, 3), env);

			// Create escalation
			escalations.push({
				theme,
				score: Math.round(score * 10) / 10,
				problem_statement: problemStatement,
				evidence: entries.slice(0, 3).map(e => ({
					text: e.text,
					source: e.source
				})),
				sentiment_distribution: sentimentDistribution,
				source_distribution: sourceDistribution,
				trend_direction: calculateTrendDirection(entries)
			});
		}

		return { success: true, escalations };
	} catch (error) {
		console.error('Workflow escalation generation failed:', error);
		return { success: false, escalations: [] };
	}
}

// Helper function to generate problem statements
async function generateProblemStatement(theme: string, entries: FeedbackEntry[], env: Env): Promise<string> {
	try {
		const feedbackText = entries.map(e => e.text).join('\n');
		const truncatedText = feedbackText.length > 300 ? feedbackText.substring(0, 300) + '...' : feedbackText;
		
		const aiResponse = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
			prompt: `Based on this feedback about ${theme}, write a professional problem statement for product managers:

Feedback examples:
${truncatedText}

Write a concise, actionable problem statement (max 60 words):`
		});

		return aiResponse.response.trim() || `Issues identified with ${theme} requiring attention`;
	} catch (error) {
		console.error('Problem statement generation failed:', error);
		return `Issues identified with ${theme} requiring attention`;
	}
}

// Helper function to calculate trend direction
function calculateTrendDirection(entries: FeedbackEntry[]): 'increasing' | 'decreasing' | 'stable' {
	if (entries.length < 3) return 'stable';
	
	const recentEntries = entries.slice(0, Math.floor(entries.length / 2));
	const olderEntries = entries.slice(Math.floor(entries.length / 2));
	
	const recentNegative = recentEntries.filter(e => e.sentiment === 'negative').length;
	const olderNegative = olderEntries.filter(e => e.sentiment === 'negative').length;
	
	if (recentNegative > olderNegative * 1.2) return 'increasing';
	if (recentNegative < olderNegative * 0.8) return 'decreasing';
	return 'stable';
}

// Step 3: Store workflow results
async function storeResults(escalations: Escalation[], env: Env): Promise<{ success: boolean }> {
	try {
		const workflowId = `workflow_${Date.now()}`;
		await env.pointer_db.prepare(
			'INSERT INTO workflow_results (escalations, workflow_id, status) VALUES (?, ?, ?)'
		).bind(JSON.stringify(escalations), workflowId, 'completed').run();
		
		return { success: true };
	} catch (error) {
		console.error('Workflow result storage failed:', error);
		return { success: false };
	}
}

// Main workflow class
export class AnalysisWorkflow {
	async run(event: any, env: Env, ctx: any): Promise<void> {
		console.log('Pointer Analysis Workflow started');
		
		try {
			// Step 1: Process all feedback
			const step1 = await processAllFeedback(env);
			if (!step1.success) {
				console.error('Workflow failed at step 1: feedback processing');
				return;
			}
			console.log(`Step 1 completed: processed ${step1.processed} feedback entries`);

			// Step 2: Generate escalations
			const step2 = await generateEscalations(env);
			if (!step2.success) {
				console.error('Workflow failed at step 2: escalation generation');
				return;
			}
			console.log(`Step 2 completed: generated ${step2.escalations.length} escalations`);

			// Step 3: Store results
			const step3 = await storeResults(step2.escalations, env);
			if (!step3.success) {
				console.error('Workflow failed at step 3: result storage');
				return;
			}
			console.log('Step 3 completed: results stored');

			console.log('Pointer Analysis Workflow completed successfully');
		} catch (error) {
			console.error('Pointer Analysis Workflow failed:', error);
		}
	}
}
