// Turns the host's answers + photos into quiz questions.
// Uses Claude when ANTHROPIC_API_KEY is set; otherwise (or on any failure) falls
// back to templates so a party never gets stuck on a loading screen.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { PROMPTS, PHOTO_KINDS, PHOTO_DECOYS, fill } from '../public/shared.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

const QuestionSchema = z.object({
  question: z.string(),
  correct_answer: z.string(),
  wrong_answers: z.array(z.string()),
});
const GenSchema = z.object({
  questions: z.array(QuestionSchema),
  photo_wrong_answers: z.array(z.object({ photo_number: z.number(), wrong_answers: z.array(z.string()) })),
});

const SYSTEM = `You write questions for a live party trivia game played on phones at a celebration (birthday, wedding, bachelor/ette party, retirement, etc.). Guests compete to prove who knows the guest of honor best.

Rules:
- Every question is multiple choice with exactly ONE correct answer and exactly THREE wrong answers.
- The correct answer must come from the facts the host gave you. Never invent facts about the honoree.
- Wrong answers must be plausible enough to make people hesitate, and funny where possible. Match the correct answer's length and style so it doesn't stand out.
- Keep answers short (under 60 characters) so they fit on a phone button.
- Tone: affectionate roast. Teasing is great; cruel, sexual, or genuinely hurtful content is not, because grandparents and coworkers are in the room. If a fact seems too private or mean to put on a big screen, soften it or skip it.
- Questions are read aloud off a TV, so keep them under 110 characters.`;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let idCounter = 0;
const newId = () => `q${Date.now().toString(36)}${(idCounter++).toString(36)}`;

// Build a playable question with options shuffled and the correct index recorded.
function makeQuestion({ text, correct, wrong, photoId = null }) {
  const clean = [...new Set(wrong.map((w) => String(w).trim()).filter((w) => w && w.toLowerCase() !== String(correct).trim().toLowerCase()))];
  const options = shuffle([String(correct).trim(), ...clean.slice(0, 3)]);
  return { id: newId(), text: String(text).trim(), options, correct: options.indexOf(String(correct).trim()), photoId };
}

function pickDecoys(pool, exclude, n = 3) {
  return shuffle(pool.filter((d) => d.toLowerCase() !== String(exclude).toLowerCase())).slice(0, n);
}

function describeInput(input) {
  const facts = input.answers
    .filter((a) => a.answer?.trim())
    .map((a) => {
      const p = PROMPTS.find((x) => x.id === a.id);
      return `- ${p ? p.label : a.id}: ${a.answer.trim()}`;
    })
    .join('\n');
  const photos = input.photos
    .map((p, i) => `Photo ${i + 1}: question "${PHOTO_KINDS[p.kind]?.q || p.question}" — correct answer: "${p.answer}"`)
    .join('\n');
  return `Guest of honor: ${input.honoree}
Occasion: ${input.occasion || 'a party'}

Facts from the host:
${facts || '(none)'}

Stories from the host:
${input.stories?.trim() || '(none)'}

Photo rounds (the photo is shown on screen; write ONLY wrong answers for these):
${photos || '(none)'}`;
}

async function callClaude(userContent) {
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: 'low', format: zodOutputFormat(GenSchema) },
    system: SYSTEM,
    messages: [{ role: 'user', content: userContent }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Claude declined this request');
  if (!response.parsed_output) throw new Error(`No structured output (stop_reason=${response.stop_reason})`);
  return response.parsed_output;
}

// ---------- Template fallback ----------
function fallbackText(input) {
  const out = [];
  for (const a of input.answers) {
    if (!a.answer?.trim()) continue;
    const p = PROMPTS.find((x) => x.id === a.id);
    if (!p) continue;
    out.push(makeQuestion({ text: fill(p.q, input.honoree), correct: a.answer.trim(), wrong: pickDecoys(p.decoys, a.answer) }));
  }
  return out;
}

function fallbackPhotoWrong(input, photo) {
  const siblings = input.photos.filter((p) => p !== photo && p.kind === photo.kind).map((p) => p.answer);
  return [...shuffle(siblings), ...pickDecoys(PHOTO_DECOYS[photo.kind] || PHOTO_DECOYS.what, photo.answer, 5)];
}

function photoQuestion(photo, wrong) {
  return makeQuestion({ text: PHOTO_KINDS[photo.kind]?.q || 'Guess the photo!', correct: photo.answer, wrong, photoId: photo.id });
}

// Spread photo rounds evenly through the text questions so it never feels samey.
function interleave(text, photos) {
  if (!photos.length) return text;
  const result = [];
  const gap = Math.max(1, Math.floor((text.length + photos.length) / (photos.length + 1)));
  let ti = 0;
  let pi = 0;
  while (ti < text.length || pi < photos.length) {
    for (let k = 0; k < gap - 1 && ti < text.length; k++) result.push(text[ti++]);
    if (pi < photos.length) result.push(photos[pi++]);
    else if (ti < text.length) result.push(text[ti++]);
  }
  return result;
}

/**
 * input: { honoree, occasion, answers: [{id, answer}], stories, photos: [{id, kind, answer}] }
 * returns { questions, ai: boolean, error?: string }
 */
export async function generateQuestions(input) {
  const photos = input.photos.filter((p) => p.answer?.trim());
  if (client) {
    try {
      const out = await callClaude(
        `${describeInput({ ...input, photos })}

Write 8 to 10 text questions using the facts and stories (use each fact at most once; turn juicy story details into extra questions). Then, for each photo round, write three wrong answers.`
      );
      const text = out.questions.slice(0, 10).map((q) => makeQuestion({ text: q.question, correct: q.correct_answer, wrong: q.wrong_answers }));
      const photoQs = photos.map((p, i) => {
        const ai = out.photo_wrong_answers.find((w) => w.photo_number === i + 1)?.wrong_answers || [];
        return photoQuestion(p, [...ai, ...fallbackPhotoWrong(input, p)]);
      });
      if (text.length) return { questions: interleave(text, photoQs), ai: true };
      throw new Error('Claude returned no questions');
    } catch (err) {
      console.error('[generate] Claude failed, using templates:', err.message);
      return { questions: buildFallback(input, photos), ai: false, error: err.message };
    }
  }
  return { questions: buildFallback(input, photos), ai: false };
}

function buildFallback(input, photos) {
  return interleave(fallbackText(input), photos.map((p) => photoQuestion(p, fallbackPhotoWrong(input, p))));
}

/** One fresh replacement question, avoiding the ones already in the game. */
export async function regenerateOne(input, existing) {
  if (client) {
    try {
      const out = await callClaude(
        `${describeInput({ ...input, photos: [] })}

These questions are already in the game, so write something DIFFERENT (a different fact or a new angle on a story):
${existing.map((q) => `- ${q.text}`).join('\n')}

Write exactly 1 new text question. Return an empty photo_wrong_answers list.`
      );
      const q = out.questions[0];
      if (q) return makeQuestion({ text: q.question, correct: q.correct_answer, wrong: q.wrong_answers });
    } catch (err) {
      console.error('[regenerate] Claude failed:', err.message);
    }
  }
  // Fallback: a template question whose prompt isn't used yet, else reshuffle a random one.
  const used = new Set(existing.map((q) => q.text));
  const candidates = fallbackText(input).filter((q) => !used.has(q.text));
  return candidates[0] || fallbackText(input)[Math.floor(Math.random() * Math.max(1, input.answers.length))] || null;
}
