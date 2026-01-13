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
const RECENCY_WEIGHTS: {
	getWeight: (daysAgo: number) => number;
} = {
	getWeight: (daysAgo: number) => {
		if (daysAgo <= 1) return 10;  // Today/today
		if (daysAgo <= 3) return 8;   // Last 3 days
		if (daysAgo <= 7) return 5;   // Last week
		if (daysAgo <= 14) return 3;  // Last 2 weeks
		return 1;                     // Older
	}
};

// Severity keywords for additional scoring
const SEVERITY_KEYWORDS: Record<string, number> = {
	'critical': 15,
	'urgent': 12,
	'crash': 10,
	'broken': 8,
	'failed': 7,
	'error': 6,
	'lost': 10,
	'security': 12,
	'payment': 11,
	'data loss': 15,
	'downtime': 9,
	'unable': 5,
	'block': 6
};

async function analyzeFeedbackWithAI(text: string, env: Env): Promise<{ sentiment: string; theme: string }> {
	const prompt = `Analyze feedback and respond with JSON only: {"sentiment": "positive|neutral|negative", "theme": "specific issue (avoid general)"}

Feedback: "${text.substring(0, 200)}"`;

	try {
		const response = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
			prompt,
			max_tokens: 30
		});

		const result = JSON.parse(response.response);
		const theme = result.theme?.toLowerCase();
		return {
			sentiment: result.sentiment || 'neutral',
			theme: (theme && theme !== 'general') ? theme : 'general'
		};
	} catch (error) {
		console.error('AI analysis failed:', error);
		return { sentiment: 'neutral', theme: 'general' };
	}
}

async function generateProblemStatement(theme: string, feedback: FeedbackEntry[], env: Env): Promise<string> {
	const themeFeedback = feedback.filter(f => f.theme === theme);
	const sampleText = themeFeedback[0]?.text || '';
	
	const prompt = `Create a professional problem statement for "${theme}" based on user feedback. Respond with ONLY the statement, no explanation or quotes.

User feedback: "${sampleText.substring(0, 100)}"

Problem Statement:`;

	try {
		const response = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
			prompt,
			max_tokens: 40
		});

		let statement = response.response.trim();
		
		// Remove any conversation artifacts and quotes
		statement = statement.replace(/^["']|["']$/g, ''); // Remove surrounding quotes
		statement = statement.replace(/^(here's|here is)a?[^:]*:/i, ''); // Remove "Here's a..." prefixes
		statement = statement.replace(/based on[^:]*:/i, ''); // Remove "based on..." prefixes
		statement = statement.replace(/according to[^:]*:/i, ''); // Remove "according to..." prefixes
		statement = statement.replace(/the issue[^:]*:/i, ''); // Remove "the issue..." prefixes
		statement = statement.trim();
		
		// Ensure it starts with "Problem Summary Statement:" and ends with a period
		if (!statement.startsWith('Problem Summary Statement:')) {
			statement = `Problem Summary Statement: ${statement}`;
		}
		if (!statement.endsWith('.')) {
			statement += '.';
		}
		
		return statement;
	} catch (error) {
		console.error('Problem statement generation failed:', error);
		return `Problem Summary Statement: Critical ${theme} issue affecting user experience.`;
	}
}

async function processAllFeedback(env: Env): Promise<void> {
	const feedback = await env.pointer_db.prepare('SELECT id, text FROM feedback WHERE sentiment IS NULL').all() as { results: { id: number; text: string }[] };
	
	for (const entry of feedback.results) {
		const analysis = await analyzeFeedbackWithAI(entry.text, env);
		await env.pointer_db.prepare(
			'UPDATE feedback SET sentiment = ?, theme = ? WHERE id = ?'
		).bind(analysis.sentiment, analysis.theme, entry.id).run();
	}
}

// Enhanced escalation scoring function with complex calculations
function calculateEscalationScore(feedback: FeedbackEntry[], theme: string): number {
	const themeFeedback = feedback.filter(f => f.theme === theme);
	if (themeFeedback.length === 0) return 0;

	// Enhanced frequency component (exponential scaling)
	const frequencyScore = Math.pow(themeFeedback.length, 1.5) * 3;

	// Enhanced sentiment component
	const sentimentScore = themeFeedback.reduce((sum, f) => 
		sum + SENTIMENT_WEIGHTS[f.sentiment || 'neutral'], 0);

	// Enhanced source component
	const sourceScore = themeFeedback.reduce((sum, f) => 
		sum + SOURCE_WEIGHTS[f.source], 0);

	// Recency component (new)
	const now = new Date();
	const recencyScore = themeFeedback.reduce((sum, f) => {
		const daysAgo = Math.floor((now.getTime() - new Date(f.created_at).getTime()) / (1000 * 60 * 60 * 24));
		return sum + RECENCY_WEIGHTS.getWeight(daysAgo);
	}, 0);

	// Severity keyword bonus (new)
	const severityScore = themeFeedback.reduce((sum, f) => {
		const text = f.text.toLowerCase();
		let severityBonus = 0;
		for (const [keyword, points] of Object.entries(SEVERITY_KEYWORDS)) {
			if (text.includes(keyword)) {
				severityBonus += points;
			}
		}
		return sum + severityBonus;
	}, 0);

	// Multi-source bonus (enhanced)
	const uniqueSources = new Set(themeFeedback.map(f => f.source)).size;
	const multiSourceBonus = uniqueSources > 1 ? Math.pow(uniqueSources, 2) * 3 : 0;

	// Trend acceleration bonus (new)
	const trend = analyzeTrend(feedback, theme);
	const trendBonus = trend === 'increasing' ? 15 : trend === 'decreasing' ? -5 : 0;

	// Customer impact multiplier (new - based on text length and urgency words)
	const avgTextLength = themeFeedback.reduce((sum, f) => sum + f.text.length, 0) / themeFeedback.length;
	const impactMultiplier = avgTextLength > 150 ? 1.3 : avgTextLength > 100 ? 1.1 : 1.0;

	const baseScore = frequencyScore + sentimentScore + sourceScore + recencyScore + severityScore + multiSourceBonus + trendBonus;
	
	return Math.round(baseScore * impactMultiplier);
}

function analyzeTrend(feedback: FeedbackEntry[], theme: string): 'increasing' | 'decreasing' | 'stable' {
	const themeFeedback = feedback.filter(f => f.theme === theme).sort((a, b) => 
		new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
	);

	if (themeFeedback.length < 3) return 'stable';

	const midPoint = Math.floor(themeFeedback.length / 2);
	const firstHalf = themeFeedback.slice(0, midPoint);
	const secondHalf = themeFeedback.slice(midPoint);

	const firstHalfFreq = firstHalf.length;
	const secondHalfFreq = secondHalf.length;

	if (secondHalfFreq > firstHalfFreq * 1.5) return 'increasing';
	if (secondHalfFreq < firstHalfFreq * 0.7) return 'decreasing';
	return 'stable';
}

async function generateTopEscalations(env: Env): Promise<Escalation[]> {
	await processAllFeedback(env);

	const feedback = await env.pointer_db.prepare(
		'SELECT * FROM feedback ORDER BY created_at DESC'
	).all() as { results: FeedbackEntry[] };

	const themes = [...new Set(feedback.results.map(f => f.theme).filter((theme): theme is string => Boolean(theme && theme !== 'general')))];
	
	// Get all escalation statuses
	const statuses = await getAllEscalationStatuses(env);
	
	const escalations: Escalation[] = [];
	for (const theme of themes) {
		const themeFeedback = feedback.results.filter(f => f.theme === theme);
		const score = calculateEscalationScore(feedback.results, theme);
		
		const sentiment_distribution = themeFeedback.reduce((acc, f) => {
			const sentiment = f.sentiment || 'neutral';
			if (sentiment in acc) {
				acc[sentiment as keyof typeof acc]++;
			}
			return acc;
		}, { positive: 0, neutral: 0, negative: 0 });

		const source_distribution = themeFeedback.reduce((acc, f) => {
			acc[f.source] = (acc[f.source] || 0) + 1;
			return acc;
		}, {} as Record<string, number>);

		const trend_direction = analyzeTrend(feedback.results, theme);
		const problem_statement = await generateProblemStatement(theme, feedback.results, env);

		const statusInfo = statuses[theme];

		escalations.push({
			theme,
			score,
			problem_statement,
			evidence: themeFeedback.slice(0, 2).map(f => ({ text: f.text, source: f.source })),
			sentiment_distribution,
			source_distribution,
			trend_direction,
			status: statusInfo?.status || 'open',
			notes: statusInfo?.notes
		});
	}

	return escalations.sort((a, b) => b.score - a.score).slice(0, 3);
}

// Workflow: Store escalation results in D1 for caching
async function storeWorkflowResults(escalations: Escalation[], env: Env): Promise<void> {
	const workflowId = `workflow_${Date.now()}`;
	await env.pointer_db.prepare(
		'INSERT INTO workflow_results (escalations, workflow_id, status) VALUES (?, ?, ?)'
	).bind(JSON.stringify(escalations), workflowId, 'completed').run();
}

// Workflow: Get cached results from previous workflow execution
async function getCachedResults(env: Env): Promise<Escalation[] | null> {
	const result = await env.pointer_db.prepare(
		'SELECT escalations FROM workflow_results ORDER BY created_at DESC LIMIT 1'
	).first();
	
	if (result && result.escalations) {
		try {
			return JSON.parse(result.escalations as string);
		} catch (error) {
			console.error('Error parsing cached results:', error);
		}
	}
	return null;
}

// Workflow: Execute background analysis (step 1)
async function workflowProcessAllFeedback(env: Env): Promise<{ success: boolean; processed: number }> {
	try {
		const feedback = await env.pointer_db.prepare('SELECT id, text FROM feedback WHERE sentiment IS NULL').all() as { results: { id: number; text: string }[] };
		
		for (const entry of feedback.results) {
			const analysis = await analyzeFeedbackWithAI(entry.text, env);
			await env.pointer_db.prepare(
				'UPDATE feedback SET sentiment = ?, theme = ? WHERE id = ?'
			).bind(analysis.sentiment, analysis.theme, entry.id).run();
		}
		
		return { success: true, processed: feedback.results.length };
	} catch (error) {
		console.error('Workflow feedback processing failed:', error);
		return { success: false, processed: 0 };
	}
}

// Workflow: Generate escalations (step 2)
async function workflowGenerateEscalations(env: Env): Promise<{ success: boolean; escalations: Escalation[] }> {
	try {
		const escalations = await generateTopEscalations(env);
		return { success: true, escalations };
	} catch (error) {
		console.error('Workflow escalation generation failed:', error);
		return { success: false, escalations: [] };
	}
}

// Workflow: Store results (step 3)
async function workflowStoreResults(escalations: Escalation[], env: Env): Promise<{ success: boolean }> {
	try {
		await storeWorkflowResults(escalations, env);
		return { success: true };
	} catch (error) {
		console.error('Workflow result storage failed:', error);
		return { success: false };
	}
}

// Resolution tracking functions
async function getEscalationStatus(theme: string, env: Env): Promise<{ status: string; notes?: string } | null> {
	const result = await env.pointer_db.prepare(
		'SELECT status, notes FROM escalation_status WHERE theme = ?'
	).bind(theme).first();
	
	return result ? { status: result.status as string, notes: result.notes as string } : null;
}

async function updateEscalationStatus(theme: string, status: string, env: Env, notes?: string): Promise<void> {
	await env.pointer_db.prepare(
		'INSERT OR REPLACE INTO escalation_status (theme, status, updated_at, notes) VALUES (?, ?, ?, ?)'
	).bind(theme, status, new Date().toISOString(), notes || null).run();
}

// Get all escalation statuses for display
async function getAllEscalationStatuses(env: Env): Promise<Record<string, { status: string; notes?: string }>> {
	const results = await env.pointer_db.prepare(
		'SELECT theme, status, notes FROM escalation_status'
	).all() as { results: { theme: string; status: string; notes?: string }[] };
	
	const statuses: Record<string, { status: string; notes?: string }> = {};
	for (const result of results.results) {
		statuses[result.theme] = {
			status: result.status,
			notes: result.notes
		};
	}
	
	return statuses;
}
async function executeWorkflow(env: Env): Promise<{ success: boolean; message: string }> {
	try {
		// Step 1: Process all feedback
		const step1 = await workflowProcessAllFeedback(env);
		if (!step1.success) {
			return { success: false, message: 'Failed to process feedback' };
		}

		// Step 2: Generate escalations
		const step2 = await workflowGenerateEscalations(env);
		if (!step2.success) {
			return { success: false, message: 'Failed to generate escalations' };
		}

		// Step 3: Store results
		const step3 = await workflowStoreResults(step2.escalations, env);
		if (!step3.success) {
			return { success: false, message: 'Failed to store results' };
		}

		return { success: true, message: `Workflow completed: processed ${step1.processed} feedback entries` };
	} catch (error) {
		console.error('Workflow execution failed:', error);
		return { success: false, message: 'Workflow execution failed' };
	}
}

function generatePopupHTML(escalations: Escalation[]): string {
	return `
	<!DOCTYPE html>
	<html>
	<head>
		<meta charset="UTF-8">
		<title>Pointer - Escalation Intelligence</title>
		<style>
			* { margin: 0; padding: 0; box-sizing: border-box; }
			body { 
				font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
				background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
				min-height: 100vh;
				color: #1a202c;
			}
			.dashboard {
				opacity: 0.3;
				position: fixed;
				top: 0; left: 0; right: 0; bottom: 0;
				background: linear-gradient(to bottom, #f7fafc, #edf2f7);
				z-index: 1;
				transition: opacity 0.3s ease;
			}
			.mock-nav {
				background: white; height: 60px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);
				display: flex; align-items: center; padding: 0 2rem;
			}
			.mock-sidebar {
				position: absolute; left: 0; top: 60px; bottom: 0; width: 250px;
				background: white; box-shadow: 1px 0 3px rgba(0,0,0,0.1);
			}
			.mock-content {
				position: absolute; left: 250px; top: 60px; right: 0; bottom: 0;
				padding: 2rem; background: #f8f9fa;
			}
			.popup-overlay {
				position: fixed; top: 0; left: 0; right: 0; bottom: 0;
				background: rgba(0,0,0,0.5); z-index: 1000;
				display: flex; align-items: center; justify-content: center;
				backdrop-filter: blur(4px);
				transition: all 0.3s ease;
			}
			.popup-overlay.minimized {
				background: transparent;
				backdrop-filter: none;
				top: auto;
				left: auto;
				right: 20px;
				bottom: auto;
				width: 350px;
				height: 120px;
				display: block;
			}
			.popup {
				background: white; border-radius: 16px; padding: 2rem;
				max-width: 600px; width: 90%; max-height: 80vh; overflow-y: auto;
				box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04);
				z-index: 1001;
				transition: all 0.3s ease;
			}
			.popup-overlay.minimized .popup {
				position: fixed;
				top: 20px;
				right: 20px;
				max-width: 350px;
				width: 350px;
				max-height: 120px;
				overflow: hidden;
				padding: 1.2rem;
				border-radius: 12px;
				box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06);
			}
			.popup h1 {
				font-size: 1.5rem; font-weight: 700; margin-bottom: 0.5rem;
				color: #2d3748;
			}
			.popup-overlay.minimized .popup h1 {
				font-size: 1.1rem;
				margin-bottom: 0.5rem;
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
			}
			.popup-overlay.minimized .view-escalations-btn {
				margin-top: 0.75rem;
				font-size: 0.9rem;
				padding: 0.6rem 1.2rem;
			}
			.popup-overlay.minimized .popup-subtitle {
				display: none;
			}
			.popup-subtitle {
				color: #718096; margin-bottom: 1.5rem; font-size: 0.875rem;
			}
			.escalation {
				background: #f8f9fa; border-radius: 12px; padding: 1.5rem;
				margin-bottom: 1rem; border-left: 4px solid #e53e3e;
			}
			.popup-overlay.minimized .escalation {
				display: none;
			}
			.feedback-form {
				background: white; border-radius: 12px; padding: 1.5rem;
				margin: 2rem auto; max-width: 600px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);
			}
			.feedback-form h3 {
				color: #2d3748; margin-bottom: 1rem; font-size: 1.25rem;
			}
			.form-group {
				margin-bottom: 1rem;
			}
			.form-group label {
				display: block; color: #4a5568; font-weight: 600; margin-bottom: 0.5rem;
			}
			.form-group select, .form-group textarea {
				width: 100%; padding: 0.75rem; border: 1px solid #e2e8f0;
				border-radius: 8px; font-family: inherit; font-size: 0.875rem;
			}
			.form-group textarea {
				resize: vertical; min-height: 100px;
			}
			.submit-btn {
				background: #4299e1; color: white; border: none; padding: 0.75rem 1.5rem;
				border-radius: 8px; cursor: pointer; font-weight: 600; width: 100%;
			}
			.submit-btn:hover { background: #3182ce; }
			.status-info {
				background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px;
				padding: 1rem; margin-bottom: 1rem; color: #075985;
			}
			.status-info .time-ago {
				font-weight: 600; color: #0c4a6e;
			}
			.success-message {
				background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534;
				padding: 1rem; border-radius: 8px; margin-top: 1rem; text-align: center;
			}
			.resolution-tracking {
				background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px;
				padding: 1rem; margin-top: 1rem;
			}
			.resolution-header {
				display: flex; justify-content: space-between; align-items: center;
				margin-bottom: 0.75rem;
			}
			.resolution-title {
				font-weight: 600; color: #2d3748; font-size: 0.875rem;
			}
			.status-badge {
				padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.75rem;
				font-weight: 600; text-transform: uppercase;
			}
			.status-open {
				background: #fed7d7; color: #c53030;
			}
			.status-in-progress {
				background: #feebc8; color: #c05621;
			}
			.status-resolved {
				background: #c6f6d5; color: #22543d;
			}
			.status-controls {
				display: flex; gap: 0.5rem; margin-top: 0.5rem;
			}
			.status-btn {
				padding: 0.25rem 0.5rem; border: 1px solid #e2e8f0; border-radius: 4px;
				background: white; color: #4a5568; font-size: 0.75rem; cursor: pointer;
				transition: all 0.2s ease;
			}
			.status-btn:hover {
				background: #f7fafc; border-color: #cbd5e0;
			}
			.status-btn.active {
				background: #4299e1; color: white; border-color: #4299e1;
			}
			.resolution-notes {
				margin-top: 0.5rem;
			}
			.resolution-notes textarea {
				width: 100%; min-height: 60px; padding: 0.5rem;
				border: 1px solid #e2e8f0; border-radius: 4px; font-size: 0.75rem;
				resize: vertical;
			}
			.update-btn {
				background: #4299e1; color: white; border: none; padding: 0.5rem 1rem;
				border-radius: 4px; font-size: 0.75rem; cursor: pointer; margin-top: 0.5rem;
			}
			.update-btn:hover { background: #3182ce; }
			.forward-section {
				background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px;
				padding: 1rem; margin-top: 1rem;
			}
			.forward-header {
				display: flex; justify-content: space-between; align-items: center;
				margin-bottom: 0.75rem;
			}
			.forward-title {
				font-weight: 600; color: #2d3748; font-size: 0.875rem;
			}
			.forward-controls {
				display: flex; gap: 0.5rem; align-items: center;
			}
			.forward-select {
				padding: 0.5rem; border: 1px solid #e2e8f0; border-radius: 4px;
				background: white; color: #4a5568; font-size: 0.75rem;
				min-width: 150px;
			}
			.forward-btn {
				background: #805ad5; color: white; border: none; padding: 0.5rem 1rem;
				border-radius: 4px; font-size: 0.75rem; cursor: pointer;
				transition: all 0.2s ease;
			}
			.forward-btn:hover { background: #6b46c1; }
			.forward-btn.submitted {
				background: #48bb78; cursor: default;
			}
			.escalation-header {
				display: flex; justify-content: between; align-items: center;
				margin-bottom: 1rem;
			}
			.escalation-title {
				font-weight: 600; font-size: 1.125rem; color: #2d3748;
			}
			.escalation-score {
				background: #e53e3e; color: white; padding: 0.25rem 0.75rem;
				border-radius: 9999px; font-size: 0.875rem; font-weight: 600;
			}
			.problem-statement {
				color: #4a5568; margin-bottom: 1rem; line-height: 1.5;
			}
			.evidence-section {
				margin-top: 1rem;
			}
			.evidence-title {
				font-weight: 600; color: #2d3748; margin-bottom: 0.5rem;
				font-size: 0.875rem;
			}
			.evidence-quote {
				background: white; padding: 0.75rem; border-radius: 8px;
				margin-bottom: 0.5rem; font-style: italic; color: #4a5568;
				font-size: 0.875rem; border-left: 3px solid #cbd5e0;
			}
			.trend-indicator {
				display: inline-block; padding: 0.25rem 0.5rem; border-radius: 6px;
				font-size: 0.75rem; font-weight: 600; margin-left: 0.5rem;
			}
			.trend-increasing { background: #fed7d7; color: #c53030; }
			.trend-stable { background: #e2e8f0; color: #4a5568; }
			.trend-decreasing { background: #c6f6d5; color: #22543d; }
			.close-btn {
				background: #4a5568; color: white; border: none; padding: 0.75rem 1.5rem;
				border-radius: 8px; cursor: pointer; font-weight: 600;
				margin-top: 1rem; width: 100%;
			}
			.close-btn:hover { background: #2d3748; }
			.popup-overlay.minimized .close-btn {
				display: none;
			}
			.view-escalations-btn {
				background: #e53e3e; color: white; border: none; padding: 0.5rem 1rem;
				border-radius: 6px; cursor: pointer; font-weight: 600;
				font-size: 0.875rem; margin-top: 0.5rem;
			}
			.view-escalations-btn:hover { background: #c53030; }
			.escalation-count {
				background: #e53e3e; color: white; padding: 0.25rem 0.5rem;
				border-radius: 9999px; font-size: 0.75rem; font-weight: 600;
				margin-left: 0.5rem;
			}
		</style>
	</head>
	<body>
		<div class="dashboard">
			<div class="mock-nav">
				<div style="font-weight: 600; color: #2d3748;">Pointer - PM Dashboard</div>
				<div style="margin-left: auto; color: #718096;">Analytics Overview</div>
			</div>
			<div class="mock-sidebar">
				<div style="padding: 1rem; font-weight: 600; color: #2d3748; border-bottom: 1px solid #e2e8f0;">Navigation</div>
				<div style="padding: 0.75rem 1rem; color: #718096;">Dashboard</div>
				<div style="padding: 0.75rem 1rem; color: #718096;">Feedback</div>
				<div style="padding: 0.75rem 1rem; color: #718096;">Analytics</div>
				<div style="padding: 0.75rem 1rem; color: #718096;">Reports</div>
			</div>
			<div class="mock-content">
				<h2 style="color: #2d3748; margin-bottom: 1rem;">Product Review Escalation Overview and Mock Ticket Submission</h2>
				
				<div class="status-info">
					<div>Last Analysis Update: <span class="time-ago" id="lastUpdate">Loading...</span></div>
					<div style="margin-top: 0.5rem; font-size: 0.875rem;">Next automatic analysis in: <span id="nextUpdate">Loading...</span></div>
				</div>
				
				<div class="feedback-form">
					<h3>Submit New Feedback</h3>
					<form id="feedbackForm">
						<div class="form-group">
							<label for="source">Source Type:</label>
							<select id="source" name="source" required>
								<option value="">Select source...</option>
								<option value="support_ticket">Support Ticket</option>
								<option value="github_issue">GitHub Issue</option>
								<option value="twitter">Twitter</option>
								<option value="survey">Survey</option>
								<option value="community_forum">Community Forum</option>
							</select>
						</div>
						<div class="form-group">
							<label for="text">Feedback Details:</label>
							<textarea id="text" name="text" placeholder="Enter the feedback details here..." required></textarea>
						</div>
						<button type="submit" class="submit-btn">Submit Feedback</button>
					</form>
					<div id="successMessage" class="success-message" style="display: none;">
						Feedback submitted successfully! It will be included in next analysis.
					</div>
				</div>
			</div>
		</div>

		<div class="popup-overlay" id="popupOverlay">
			<div class="popup">
				<h1> Critical Escalations Detected</h1>
				<div class="popup-subtitle">Top 3 issues requiring immediate attention based on user feedback analysis</div>
				
				${escalations.map((escalation, index) => `
					<div class="escalation">
						<div class="escalation-header">
							<div class="escalation-title">
								${index + 1}. ${escalation.theme}
								<span class="trend-indicator trend-${escalation.trend_direction}">
									${escalation.trend_direction === 'increasing' ? '📈' : escalation.trend_direction === 'decreasing' ? '📉' : '➡️'} 
									${escalation.trend_direction}
								</span>
							</div>
							<div class="escalation-score">Score: ${escalation.score}</div>
						</div>
						<div class="problem-statement">${escalation.problem_statement}</div>
						<div class="evidence-section">
							<div class="evidence-title">Key Review:</div>
							${escalation.evidence.map(evidence => {
								if (typeof evidence === 'string') {
									// Old format: just string
									return `<div class="evidence-quote">"${evidence}"</div>`;
								} else {
									// New format: object with text and source
									return `<div class="evidence-quote">"${evidence.text}" (${evidence.source})</div>`;
								}
							}).join('')}
						</div>
						
						<div class="forward-section">
							<div class="forward-header">
								<div class="forward-title">Forward to:</div>
							</div>
							
							<div class="forward-controls">
								<select class="forward-select" id="forward-${index}">
									<option value="">Select team...</option>
									<option value="engineering">Engineering Team</option>
									<option value="product">Product Team</option>
									<option value="design">Design Team</option>
									<option value="support">Customer Support</option>
									<option value="security">Security Team</option>
									<option value="infrastructure">Infrastructure Team</option>
									<option value="jira">JIRA</option>
								</select>
								<button class="forward-btn" id="forwardBtn-${index}" onclick="forwardEscalation('${escalation.theme}', ${index})">
									Submit
								</button>
							</div>
						</div>
						
						<div class="resolution-tracking">
							<div class="resolution-header">
								<div class="resolution-title">Resolution Status</div>
								<span class="status-badge status-${escalation.status || 'open'}" id="status-${index}">
									${escalation.status || 'open'}
								</span>
							</div>
							
							<div class="status-controls">
								<button class="status-btn ${escalation.status === 'open' ? 'active' : ''}" 
										onclick="updateStatus('${escalation.theme}', 'open', ${index})">Open</button>
								<button class="status-btn ${escalation.status === 'in-progress' ? 'active' : ''}" 
										onclick="updateStatus('${escalation.theme}', 'in-progress', ${index})">In Progress</button>
								<button class="status-btn ${escalation.status === 'resolved' ? 'active' : ''}" 
										onclick="updateStatus('${escalation.theme}', 'resolved', ${index})">Resolved</button>
							</div>
						</div>
					</div>
				`).join('')}
				
				<button class="close-btn" onclick="minimizePopup()">
					Acknowledge
				</button>
				<button class="view-escalations-btn" onclick="expandPopup()" style="display: none;" id="expandBtn">
					View Escalations
				</button>
			</div>
		</div>

		<script>
		function minimizePopup() {
			const overlay = document.getElementById('popupOverlay');
			const expandBtn = document.getElementById('expandBtn');
			const dashboard = document.querySelector('.dashboard');
			
			overlay.classList.add('minimized');
			expandBtn.style.display = 'block';
			dashboard.style.opacity = '1';
		}
		function expandPopup() {
			const overlay = document.getElementById('popupOverlay');
			const expandBtn = document.getElementById('expandBtn');
			const dashboard = document.querySelector('.dashboard');
			
			overlay.classList.remove('minimized');
			expandBtn.style.display = 'none';
			dashboard.style.opacity = '0.3';
		}

		// Time tracking functions
		function formatTimeAgo(dateString) {
			const date = new Date(dateString);
			const now = new Date();
			const diffMs = now - date;
			const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
			const diffDays = Math.floor(diffHours / 24);
			
			if (diffDays > 0) {
				return diffDays + " day" + (diffDays > 1 ? "s" : "") + " ago";
			} else if (diffHours > 0) {
				return diffHours + " hour" + (diffHours > 1 ? "s" : "") + " ago";
			} else {
				return "Just now";
			}
		}

		function timeUntilNextAnalysis() {
			const now = new Date();
			const nextAnalysis = new Date(now);
			nextAnalysis.setHours(nextAnalysis.getHours() + 6);
			nextAnalysis.setMinutes(0, 0, 0);
			
			const diffMs = nextAnalysis - now;
			const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
			const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
			
			return diffHours + "h " + diffMinutes + "m";
		}

		// Load status information
		async function loadStatus() {
			try {
				const response = await fetch('/status');
				const status = await response.json();
				
				// Update time displays
				if (status.lastUpdate === 'Available') {
					document.getElementById('lastUpdate').textContent = 'Available';
				} else {
					document.getElementById('lastUpdate').textContent = status.lastUpdate;
				}
				
				document.getElementById('nextUpdate').textContent = timeUntilNextAnalysis();
				
				// Update every minute
				setInterval(() => {
					document.getElementById('nextUpdate').textContent = timeUntilNextAnalysis();
				}, 60000);
				
			} catch (error) {
				console.error('Error loading status:', error);
				document.getElementById('lastUpdate').textContent = 'Unknown';
				document.getElementById('nextUpdate').textContent = 'Unknown';
			}
		}

		// Feedback form submission
		async function submitFeedback(event) {
			event.preventDefault();
			
			const formData = new FormData(event.target);
			const source = formData.get('source');
			const text = formData.get('text');
			
			console.log('Submitting feedback:', { source, text });
			
			try {
				const response = await fetch('/feedback', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ source, text })
				});
				
				const result = await response.json();
				console.log('Feedback submission response:', result);
				
				if (response.ok) {
					// Show success message
					document.getElementById('successMessage').style.display = 'block';
					
					// Reset form
					event.target.reset();
					
					// Hide success message after 3 seconds
					setTimeout(() => {
						document.getElementById('successMessage').style.display = 'none';
					}, 3000);
					
				} else {
					console.error('Submission failed:', result);
					alert('Error submitting feedback. Please try again.');
				}
			} catch (error) {
				console.error('Error submitting feedback:', error);
				alert('Error submitting feedback. Please try again.');
			}
		}

		// Initialize on page load
		document.addEventListener('DOMContentLoaded', function() {
			loadStatus();
			document.getElementById('feedbackForm').addEventListener('submit', submitFeedback);
		});

		// Resolution tracking functions
		let currentStatuses = {};

		function updateStatus(theme, status, index) {
			// Update button states
			const buttons = document.querySelectorAll('.status-controls button[onclick*="' + theme + '"]');
			buttons.forEach(btn => btn.classList.remove('active'));
			event.target.classList.add('active');
			
			// Update status badge
			const statusBadge = document.getElementById('status-' + index);
			statusBadge.textContent = status;
			statusBadge.className = 'status-badge status-' + status;
			
			// Auto-save status change
			saveResolution(theme, status);
		}

		async function saveResolution(theme, status) {
			try {
				const response = await fetch('/resolution', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						theme: theme,
						status: status,
						notes: ''
					})
				});
				
				if (response.ok) {
					// Show brief success feedback on button
					const activeBtn = document.querySelector('.status-btn.active[onclick*="' + theme + '"]');
					const originalText = activeBtn.textContent;
					activeBtn.textContent = '✓ Saved';
					activeBtn.style.background = '#48bb78';
					
					setTimeout(() => {
						activeBtn.textContent = originalText;
						activeBtn.style.background = '#4299e1';
					}, 1000);
				} else {
					console.error('Error updating resolution status');
				}
			} catch (error) {
				console.error('Error updating resolution:', error);
			}
		}

		function forwardEscalation(theme, index) {
			const select = document.getElementById('forward-' + index);
			const button = document.getElementById('forwardBtn-' + index);
			const selectedTeam = select.value;
			
			if (!selectedTeam) {
				alert('Please select a team to forward to');
				return;
			}
			
			// Mock forward functionality
			console.log('Forwarding escalation "' + theme + '" to: ' + selectedTeam);
			
			// Update button to show submitted state
			button.textContent = 'Submitted';
			button.classList.add('submitted');
			button.disabled = true;
			select.disabled = true;
			
			// Store forward info (mock)
			if (!currentStatuses[theme]) {
				currentStatuses[theme] = {};
			}
			currentStatuses[theme].forwardedTo = selectedTeam;
			currentStatuses[theme].forwardedAt = new Date().toISOString();
		}
		</script>
	</body>
	</html>
	`;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		
		// Workflow endpoints
		if (url.pathname === '/workflow') {
			const action = url.searchParams.get('action');
			
			switch (action) {
				case 'process_all_feedback':
					const result1 = await workflowProcessAllFeedback(env);
					return new Response(JSON.stringify(result1), {
						headers: { 'Content-Type': 'application/json' }
					});
				
				case 'generate_escalations':
					const result2 = await workflowGenerateEscalations(env);
					return new Response(JSON.stringify(result2), {
						headers: { 'Content-Type': 'application/json' }
					});
				
				case 'store_escalation_results':
					const escalationsParam = url.searchParams.get('escalations');
					if (escalationsParam) {
						const escalations = JSON.parse(escalationsParam);
						const result3 = await workflowStoreResults(escalations, env);
						return new Response(JSON.stringify(result3), {
							headers: { 'Content-Type': 'application/json' }
						});
					}
					return new Response('Missing escalations parameter', { status: 400 });
				
				case 'execute':
					const workflowResult = await executeWorkflow(env);
					return new Response(JSON.stringify(workflowResult), {
						headers: { 'Content-Type': 'application/json' }
					});
				
				default:
					return new Response('Invalid workflow action', { status: 400 });
			}
		}

		// Resolution tracking endpoint
		if (url.pathname === '/resolution' && request.method === 'POST') {
			try {
				const { theme, status, notes } = await request.json() as { theme: string; status: string; notes?: string };
				
				if (!theme || !status) {
					return new Response('Missing theme or status', { status: 400 });
				}
				
				if (!['open', 'in-progress', 'resolved'].includes(status)) {
					return new Response('Invalid status', { status: 400 });
				}
				
				await updateEscalationStatus(theme, status, env, notes);
				
				return new Response(JSON.stringify({ success: true }), {
					headers: { 'Content-Type': 'application/json' }
				});
			} catch (error) {
				console.error('Error updating resolution:', error);
				return new Response('Internal Server Error', { status: 500 });
			}
		}

		// Feedback submission endpoint
		if (url.pathname === '/feedback' && request.method === 'POST') {
			try {
				const { source, text } = await request.json() as { source: string; text: string };
				
				console.log('Feedback submission received:', { source, text });
				
				if (!source || !text) {
					return new Response('Missing source or text', { status: 400 });
				}
				
				// Insert new feedback into D1
				const result = await env.pointer_db.prepare(
					'INSERT INTO feedback (source, text, created_at) VALUES (?, ?, ?)'
				).bind(source, text, new Date().toISOString()).run();
				
				console.log('Feedback inserted successfully:', result);
				
				return new Response(JSON.stringify({ success: true, insertedId: result.meta.last_row_id }), {
					headers: { 'Content-Type': 'application/json' }
				});
			} catch (error) {
				console.error('Error submitting feedback:', error);
				return new Response('Internal Server Error', { status: 500 });
			}
		}

		// Status endpoint for workflow monitoring
		if (url.pathname === '/status') {
			const cached = await getCachedResults(env);
			
			if (cached) {
				// Get the actual timestamp from workflow_results
				const result = await env.pointer_db.prepare(
					'SELECT created_at FROM workflow_results ORDER BY created_at DESC LIMIT 1'
				).first();
				
				const lastUpdate = result?.created_at || new Date().toISOString();
				const status = {
					status: 'ready',
					lastUpdate: lastUpdate,
					escalationsCount: cached.length
				};
				
				return new Response(JSON.stringify(status), {
					headers: { 'Content-Type': 'application/json' }
				});
			} else {
				const status = {
					status: 'processing',
					lastUpdate: 'No cached results',
					escalationsCount: 0
				};
				
				return new Response(JSON.stringify(status), {
					headers: { 'Content-Type': 'application/json' }
				});
			}
		}

		// Main endpoints - try to use cached results first (background processing)
		if (url.pathname === '/escalations' || url.pathname === '/') {
			try {
				// Try to get cached results first (no waiting for AI)
				let escalations = await getCachedResults(env);
				
				// If no cached results, fall back to real-time processing
				if (!escalations) {
					escalations = await generateTopEscalations(env);
				}
				
				return new Response(generatePopupHTML(escalations), {
					headers: { 'Content-Type': 'text/html' }
				});
			} catch (error) {
				console.error('Error generating escalations:', error);
				return new Response('Internal Server Error', { status: 500 });
			}
		}

		return new Response('Not Found', { status: 404 });
	},

	// Scheduled event handler for automatic workflow execution
	async scheduled(event, env, ctx): Promise<void> {
		console.log('Scheduled workflow execution started');
		
		try {
			const result = await executeWorkflow(env);
			console.log('Scheduled workflow result:', result.message);
		} catch (error) {
			console.error('Scheduled workflow failed:', error);
		}
	},
} satisfies ExportedHandler<Env>;
