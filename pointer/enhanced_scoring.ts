// Enhanced escalation scoring function with more complex calculations

interface FeedbackEntry {
	id: number;
	source: string;
	text: string;
	sentiment?: string;
	theme?: string;
	created_at: string;
}

// Enhanced source weights for escalation scoring
const SOURCE_WEIGHTS: Record<string, number> = {
	support_ticket: 8,
	github_issue: 6,
	twitter: 4,
	survey: 3
};

// Enhanced sentiment weights
const SENTIMENT_WEIGHTS: Record<string, number> = {
	negative: 6,
	neutral: 3,
	positive: 1
};

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
