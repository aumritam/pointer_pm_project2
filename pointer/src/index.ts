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
	evidence: string[];
	sentiment_distribution: { positive: number; neutral: number; negative: number };
	source_distribution: Record<string, number>;
	trend_direction: 'increasing' | 'decreasing' | 'stable';
}

interface Env {
	pointer_db: D1Database;
	AI: any;
}

// Source weights for escalation scoring
const SOURCE_WEIGHTS: Record<string, number> = {
	support_ticket: 4,
	github_issue: 3,
	twitter: 2,
	community_forum: 1
};

// Sentiment weights
const SENTIMENT_WEIGHTS: Record<string, number> = {
	negative: 3,
	neutral: 2,
	positive: 1
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

function calculateEscalationScore(feedback: FeedbackEntry[], theme: string): number {
	const themeFeedback = feedback.filter(f => f.theme === theme);
	if (themeFeedback.length === 0) return 0;

	// Frequency component
	const frequencyScore = themeFeedback.length * 2;

	// Sentiment component
	const sentimentScore = themeFeedback.reduce((sum, f) => 
		sum + SENTIMENT_WEIGHTS[f.sentiment || 'neutral'], 0);

	// Source component
	const sourceScore = themeFeedback.reduce((sum, f) => 
		sum + SOURCE_WEIGHTS[f.source], 0);

	// Multi-source bonus
	const uniqueSources = new Set(themeFeedback.map(f => f.source)).size;
	const multiSourceBonus = uniqueSources > 1 ? uniqueSources * 5 : 0;

	return frequencyScore + sentimentScore + sourceScore + multiSourceBonus;
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

		escalations.push({
			theme,
			score,
			problem_statement,
			evidence: themeFeedback.slice(0, 2).map(f => f.text),
			sentiment_distribution,
			source_distribution,
			trend_direction
		});
	}

	return escalations.sort((a, b) => b.score - a.score).slice(0, 3);
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
			}
			.popup {
				background: white; border-radius: 16px; padding: 2rem;
				max-width: 600px; width: 90%; max-height: 80vh; overflow-y: auto;
				box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04);
				z-index: 1001;
			}
			.popup h1 {
				font-size: 1.5rem; font-weight: 700; margin-bottom: 0.5rem;
				color: #2d3748;
			}
			.popup-subtitle {
				color: #718096; margin-bottom: 1.5rem; font-size: 0.875rem;
			}
			.escalation {
				background: #f8f9fa; border-radius: 12px; padding: 1.5rem;
				margin-bottom: 1rem; border-left: 4px solid #e53e3e;
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
		</style>
	</head>
	<body>
		<div class="dashboard">
			<div class="mock-nav">
				<div style="font-weight: 600; color: #2d3748;">Pointer PM Dashboard</div>
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
				<h2 style="color: #2d3748; margin-bottom: 1rem;">Product Metrics Overview</h2>
				<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem;">
					<div style="background: white; padding: 1rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
						<div style="color: #718096; font-size: 0.875rem;">Total Users</div>
						<div style="font-size: 1.5rem; font-weight: 600; color: #2d3748;">12,847</div>
					</div>
					<div style="background: white; padding: 1rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
						<div style="color: #718096; font-size: 0.875rem;">Active Sessions</div>
						<div style="font-size: 1.5rem; font-weight: 600; color: #2d3748;">3,291</div>
					</div>
					<div style="background: white; padding: 1rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
						<div style="color: #718096; font-size: 0.875rem;">Satisfaction</div>
						<div style="font-size: 1.5rem; font-weight: 600; color: #2d3748;">87.3%</div>
					</div>
				</div>
			</div>
		</div>

		<div class="popup-overlay">
			<div class="popup">
				<h1>🚨 Critical Escalations Detected</h1>
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
							<div class="evidence-title">🔍 Key Evidence:</div>
							${escalation.evidence.map(quote => `
								<div class="evidence-quote">"${quote}"</div>
							`).join('')}
						</div>
					</div>
				`).join('')}
				
				<button class="close-btn" onclick="document.querySelector('.popup-overlay').style.display='none'">
					Acknowledge & Continue
				</button>
			</div>
		</div>
	</body>
	</html>
	`;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		
		if (url.pathname === '/escalations') {
			try {
				const escalations = await generateTopEscalations(env);
				return new Response(generatePopupHTML(escalations), {
					headers: { 'Content-Type': 'text/html' }
				});
			} catch (error) {
				console.error('Error generating escalations:', error);
				return new Response('Internal Server Error', { status: 500 });
			}
		}

		if (url.pathname === '/') {
			try {
				const escalations = await generateTopEscalations(env);
				return new Response(generatePopupHTML(escalations), {
					headers: { 'Content-Type': 'text/html' }
				});
			} catch (error) {
				console.error('Error:', error);
				return new Response('Error loading dashboard', { status: 500 });
			}
		}

		return new Response('Not Found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
