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
        })) : [],
        irNteRecords: Array.isArray(evidence.irNteRecords) ? evidence.irNteRecords.slice(0, 20).map(r => ({
          type: String(r.type || '').slice(0, 80),
          incidentDate: String(r.incidentDate || '').slice(0, 20),
          issuedDate: String(r.issuedDate || '').slice(0, 20),
          responseDeadline: String(r.responseDeadline || '').slice(0, 20),
          responseReceivedDate: String(r.responseReceivedDate || '').slice(0, 20),
          category: String(r.category || '').slice(0, 120),
          subject: String(r.subject || '').slice(0, 500),
          details: String(r.details || '').slice(0, 2000),
          policy: String(r.policy || '').slice(0, 1000),
          employeeExplanation: String(r.employeeExplanation || '').slice(0, 1500),
          findings: String(r.findings || '').slice(0, 1500),
          status: String(r.status || '').slice(0, 80)
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
              score: { type: 'integer', minimum: 0, maximum: 100 },
              assessment: { type: 'string' }
            },
            required: ['key', 'score', 'assessment']
          }
        },
        overall_assessment: { type: 'string' },
        overall_status: { type: 'string' }
      },
      required: ['assessments', 'overall_assessment', 'overall_status']
    };
    const useOpenRouter = process.env.OPENAI_API_KEY.startsWith('sk-or-');
    const instructions = "You are an experienced, fair VA training lead producing a weekly evaluation report. Use raw QA audit, coaching, and IR/NTE records as primary evidence; currentAssessment is a weak auto-generated draft and must not be copied or lightly paraphrased. For each criterion, write a specific, concise, professional trainer assessment in 2–4 sentences, explaining concrete strengths or gaps, impact on performance, and documented coaching progress where supported. Do not force unrelated evidence into a criterion. Assign a whole-number score from 0 to 100 for each criterion. If a score is explicitly present in the supplied criterion score, preserve it exactly. If null, derive a cautious evidence-based score from the raw QA/coaching records using this rubric: 90–100 consistently exceeds expectations with clear evidence; 80–89 performs well with limited gaps; 70–79 developing/partially consistent with identifiable gaps; 60–69 multiple material gaps or inconsistent performance; 0–59 serious or repeated deficiencies. Do not give 100 without exceptional explicit evidence. When there is genuinely insufficient evidence, use 70 as a provisional baseline and clearly state that evidence is limited. Scores should reflect the whole evaluation period and coaching follow-through. Consider IR/NTE records in the overall assessment and relevant criteria when the documented incident directly relates to attendance, conduct, quality, communication, integrity, or policy compliance. Treat allegations as allegations until findings are documented; accurately report whether an explanation is pending or received and whether the matter is resolved. Never infer guilt or invent a disciplinary outcome. The separate IR/NTE evaluation in the report should summarize only documented records for the selected week. Calculate the overall score as the rounded arithmetic mean of the four criterion scores. Use status labels: 90–100 Exceeds Expectations; 80–89 Meets Expectations; 70–79 Developing – Requires Continued Coaching; 60–69 Below Expectations – Focused Coaching Required; 0–59 Unsatisfactory – Immediate Improvement Required. overall_assessment is a concise 1–2 sentence summary. Use respectful business English. Never invent events or coaching outcomes.";
    const model = process.env.OPENAI_MODEL || (useOpenRouter ? 'openai/gpt-4o-mini' : 'gpt-4o-mini');
    const response = await fetch(useOpenRouter ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
        'Content-Type': 'application/json',
        ...(useOpenRouter ? { 'HTTP-Referer': 'https://kanako-progress-hub.vercel.app', 'X-Title': 'Kanako Weekly Report' } : {})
      },
      body: JSON.stringify(useOpenRouter ? {
        model,
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: JSON.stringify(input) }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'weekly_report_assessments', strict: true, schema }
        },
        max_tokens: 2200
      } : {
        model,
        instructions,
        input: JSON.stringify(input),
        text: { format: { type: 'json_schema', name: 'weekly_report_assessments', strict: true, schema } },
        max_output_tokens: 2200
      })
    });
    const result = await response.json();
    if (!response.ok) {
      const message = result?.error?.message || 'AI provider request failed.';
      return res.status(502).json({ error: (message + (useOpenRouter ? ' Check that your OpenRouter key is active and the selected model is available.' : ' Check that your OpenAI Platform key is valid.')).slice(0, 300) });
    }
    const output = String(useOpenRouter
      ? result?.choices?.[0]?.message?.content || ''
      : result.output_text ||
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
    const assessments = Array.isArray(parsed.assessments) ? parsed.assessments.filter(x => allowed.has(x.key) && typeof x.assessment === 'string' && Number.isInteger(x.score) && x.score >= 0 && x.score <= 100).map(x => ({ key: x.key, score: x.score, assessment: x.assessment.slice(0, 5000) })) : [];
    if (assessments.length !== 4 || typeof parsed.overall_assessment !== 'string' || typeof parsed.overall_status !== 'string') {
      return res.status(502).json({ error: 'The AI response did not match the required report structure.' });
    }
    const overallScore = Math.round(assessments.reduce((sum, item) => sum + item.score, 0) / 4);
    return res.status(200).json({ assessments, overall_score: overallScore, overall_status: parsed.overall_status.slice(0, 120), overall_assessment: parsed.overall_assessment.slice(0, 2000) });
  } catch (error) {
    return res.status(500).json({ error: 'Could not generate AI assessments. ' + String(error?.message || '').slice(0, 180) });
  }
}
