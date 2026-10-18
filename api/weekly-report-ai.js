export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'AI is not configured yet. Add OPENAI_API_KEY to the Vercel project environment variables.' });
  }
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const criteria = Array.isArray(body.criteria) ? body.criteria.slice(0, 4) : [];
    const evidence = body.evidence && typeof body.evidence === 'object' ? body.evidence : {};
    if (criteria.length !== 4) return res.status(400).json({ error: 'Four weekly evaluation criteria are required.' });
    const input = {
      trainee: String(body.trainee || 'Trainee').slice(0, 120),
      trainer: String(body.trainer || 'Trainer').slice(0, 120),
      period: String(body.period || '').slice(0, 80),
      criteria: criteria.map(c => ({
        name: String(c.name || '').slice(0, 80),
        score: c.score === null || c.score === '' ? null : Number(c.score),
        currentAssessment: String(c.assessment || '').slice(0, 4000)
      })),
      evidence: {
        audits: Array.isArray(evidence.audits) ? evidence.audits.slice(0, 12).map(a => ({
          date: String(a.date || '').slice(0, 20),
          score: a.score === null ? null : Number(a.score),
          strengths: String(a.strengths || '').slice(0, 1500),
          gaps: String(a.gaps || '').slice(0, 1500),
          notes: String(a.notes || '').slice(0, 2000)
        })) : [],
        coachings: Array.isArray(evidence.coachings) ? evidence.coachings.slice(0, 20).map(c => ({
          date: String(c.date || '').slice(0, 20),
          focus: String(c.focus || '').slice(0, 1500),
          strengths: String(c.strengths || '').slice(0, 1000),
          discussion: String(c.discussion || '').slice(0, 2000),
          smartPlan: String(c.smartPlan || '').slice(0, 1500),
          outcome: String(c.outcome || '').slice(0, 1000)
        })) : []
      }
    };
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        assessments: {
          type: 'array',
          minItems: 4,
          maxItems: 4,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              key: { type: 'string', enum: ['tool_navigation', 'critical_thinking', 'communication', 'core_values'] },
              assessment: { type: 'string' }
            },
            required: ['key', 'assessment']
          }
        },
        overall_assessment: { type: 'string' }
      },
      required: ['assessments', 'overall_assessment']
    };
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        instructions: 'You are an experienced, fair, evidence-based VA trainer writing a professional weekly performance report. Rewrite assessments in polished, objective, constructive business English. Use only the supplied evidence. Do not invent events, scores, achievements, failures, motives, or action plans. Keep each criterion assessment concise (2–5 sentences), connect evidence to performance, and state missing evidence clearly. Preserve every numeric score exactly as supplied; do not calculate, change, or recommend scores. Overall assessment should summarize the week, strengths, development priorities, and coaching follow-through without blame. Use respectful coaching language and avoid exaggeration.',
        input: JSON.stringify(input),
        text: { format: { type: 'json_schema', name: 'weekly_report_assessments', strict: true, schema } },
        max_output_tokens: 2200
      })
    });
    const result = await response.json();
    if (!response.ok) {
      const message = result?.error?.message || 'AI provider request failed.';
      return res.status(502).json({ error: message.slice(0, 300) });
    }
    // The raw Responses API HTTP payload does not include the SDK-only output_text convenience property.
    // Extract the text from the returned output message content instead.
    const output = String(
      result.output_text ||
      (Array.isArray(result.output)
        ? result.output.flatMap(item => Array.isArray(item.content) ? item.content : [])
            .filter(part => part && (part.type === 'output_text' || typeof part.text === 'string'))
            .map(part => part.text || '')
            .join('')
        : '')
    );
    if (!output) return res.status(502).json({ error: 'The AI provider returned an empty response.' });
    const parsed = JSON.parse(output);
    const allowed = new Set(['tool_navigation', 'critical_thinking', 'communication', 'core_values']);
    const assessments = Array.isArray(parsed.assessments) ? parsed.assessments.filter(x => allowed.has(x.key) && typeof x.assessment === 'string').map(x => ({ key: x.key, assessment: x.assessment.slice(0, 5000) })) : [];
    if (assessments.length !== 4 || typeof parsed.overall_assessment !== 'string') {
      return res.status(502).json({ error: 'The AI response did not match the required report structure.' });
    }
    return res.status(200).json({ assessments, overall_assessment: parsed.overall_assessment.slice(0, 8000) });
  } catch (error) {
    return res.status(500).json({ error: 'Could not generate AI assessments. ' + String(error?.message || '').slice(0, 180) });
  }
}
