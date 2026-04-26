const fetch = require('node-fetch');
require('dotenv').config();

// ---------------- ENV ----------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WAVESPEED_API_KEY = process.env.WAVESPEED_API_KEY;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY;

// ---------------- JWT / FIREBASE AUTH ----------------
function str2ab(pem) {
  const clean = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\\n/g, '')
    .replace(/[\r\n\s]/g, '');
  const binary = atob(clean);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);
  return buffer.buffer;
}

async function getAccessToken() {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;

  function base64url(obj) {
    return btoa(JSON.stringify(obj))
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  const headerB64 = base64url({ alg: 'RS256', typ: 'JWT' });
  const payloadB64 = base64url({
    iss: FIREBASE_CLIENT_EMAIL,
    sub: FIREBASE_CLIENT_EMAIL,
    aud: 'https://oauth2.googleapis.com/token',
    iat, exp,
    scope: 'https://www.googleapis.com/auth/datastore',
  });

  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'pkcs8', str2ab(FIREBASE_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput)
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const jwt = `${signingInput}.${sigB64}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to get Firebase access token');
  return data.access_token;
}

// ---------------- FIRESTORE HELPERS ----------------
function toFirestoreValue(val) {
  if (typeof val === 'number') return { integerValue: String(val) };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestoreValue) } };
  return { stringValue: String(val ?? '') };
}

// Merge-updates nested fields e.g. Monday.LunchName without touching other fields
async function firestoreMergeUpdate(docPath, day, mealFields, token) {
  const fieldPaths = Object.keys(mealFields).map((f) => `${day}.${f}`);
  const maskParams = fieldPaths
    .map((p) => `updateMask.fieldPaths=${encodeURIComponent(p)}`)
    .join('&');

  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${docPath}?${maskParams}`;

  // Build nested fields structure: { Monday: { mapValue: { fields: { LunchName: ... } } } }
  const innerFields = {};
  for (const [key, val] of Object.entries(mealFields)) {
    innerFields[key] = toFirestoreValue(val);
  }

  const body = {
    fields: {
      [day]: {
        mapValue: { fields: innerFields },
      },
    },
  };

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Firestore merge update failed: ${err}`);
  }
}

// ---------------- WAVESPEED ----------------
async function generateWaveSpeedImage(prompt) {
  async function submit() {
    const res = await fetch(
      'https://api.wavespeed.ai/api/v3/openai/gpt-image-1.5/text-to-image',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${WAVESPEED_API_KEY}`,
        },
        body: JSON.stringify({
          enable_base64_output: false,
          enable_sync_mode: false,
          output_format: 'jpeg',
          prompt,
          quality: 'low',
          size: '1024*1024',
        }),
      }
    );
    const json = JSON.parse(await res.text());
    if (!res.ok || !json.data?.id || !json.data?.urls?.get) {
      throw new Error(`WaveSpeed submit failed: ${JSON.stringify(json)}`);
    }
    return json.data;
  }

  async function poll(pollUrl, maxAttempts = 25) {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const res = await fetch(pollUrl, {
        headers: { Authorization: `Bearer ${WAVESPEED_API_KEY}` },
      });
      const json = JSON.parse(await res.text());
      const status = json.data?.status || json.status;
      if (status === 'completed') return json.data?.outputs?.[0] || null;
      if (status === 'failed') return null;
    }
    return null;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const data = await submit();
      const imageUrl = await poll(data.urls.get);
      if (imageUrl) return imageUrl;
    } catch (err) {
      console.error(`❌ WaveSpeed attempt ${attempt} failed:`, err.message);
    }
  }
  return null;
}

// ---------------- PARSE DAY + MEAL FROM dayMeal ----------------
// e.g. "MondayLunch" → { day: "Monday", meal: "Lunch" }
function parseDayMeal(dayMeal) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const meals = ['Breakfast', 'Lunch', 'Dinner'];

  for (const day of days) {
    if (dayMeal.startsWith(day)) {
      const meal = dayMeal.slice(day.length);
      if (meals.includes(meal)) return { day, meal };
    }
  }
  throw new Error(`Invalid dayMeal value: "${dayMeal}". Expected format like "MondayLunch"`);
}

// ---------------- RESOLVE DOC PATH ----------------
// Accepts either "Timetable/abc123" or just "abc123"
function resolveDocPath(ref) {
  if (ref.includes('/')) return ref; // already a full path
  return `Timetable/${ref}`;
}

// ---------------- OPENAI: GET MEAL DATA ----------------
async function getMealFromOpenAI(foodName, meal) {
  const mealLower = meal.toLowerCase();

  const systemPrompt = `
You are a professional Nigerian meal planner and chef.
Given a meal name, return a detailed structured JSON object for that specific meal.

Rules:
- Nigerian meals only
- instructions MUST have a minimum of 9 steps and a maximum of 12 steps
- estimated_cost must be an integer in Naira
- All image prompts must be photorealistic and append "low quality" at the end
- Return ONLY valid JSON with no extra text, no markdown, no code fences

Return exactly this JSON structure:
{
  "name": string,
  "description": string,
  "ingredients_used": string[],
  "missing_ingredients": string[],
  "instructions": string[], (9 to 12 steps)
  "equipment": string[],
  "estimated_cost": integer,
  "image_prompts": {
    "food": string,
    "step_1": string,
    "step_5": string,
    "step_9": string
  }
}
  `.trim();

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 2000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Generate the meal data for: ${foodName} (this is the ${mealLower})` },
      ],
    }),
  });

  const raw = await res.text();
  if (!res.ok) throw new Error(`OpenAI error: ${raw}`);

  const openAIResult = JSON.parse(raw);
  const content = openAIResult.choices[0].message.content;

  let jsonStr = content.replace(/```json|```/g, '').trim();
  const firstBrace = jsonStr.indexOf('{');
  const lastBrace = jsonStr.lastIndexOf('}');
  jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);

  return JSON.parse(jsonStr);
}

// ---------------- MAIN FUNCTION ----------------
/**
 * Updates a single meal slot in a Timetable Firestore document.
 *
 * @param {string} foodName  - e.g. "Jollof Rice"
 * @param {string} dayMeal   - e.g. "MondayLunch", "TuesdayDinner"
 * @param {string} docRef    - Firestore doc path ("Timetable/abc123") or just ID ("abc123")
 */
async function updateSingleMeal(foodName, dayMeal, docRef) {
  console.log(`🍽️ Starting single meal update: ${foodName} → ${dayMeal}`);

  const { day, meal } = parseDayMeal(dayMeal);
  const docPath = resolveDocPath(docRef);

  console.log(`📅 Day: ${day} | Meal: ${meal} | Doc: ${docPath}`);

  // 1️⃣ Get Firebase token
  const token = await getAccessToken();
  console.log('🔑 Firebase token obtained');

  // 2️⃣ Call OpenAI for meal data
  console.log('🤖 Calling OpenAI...');
  const mealData = await getMealFromOpenAI(foodName, meal);
  console.log(`✅ OpenAI returned data for: ${mealData.name}`);

  // 3️⃣ Build field name prefix — handles the MissingIngredients flip
  // e.g. meal = "Breakfast" → prefix = "Breakfast", missing key = "MissingIngredientsBreakfast"
  // Note: cost field follows your existing pattern: breakfastcost / lunchcost / dinnercost (lowercase)
  const prefix = meal; // "Breakfast" | "Lunch" | "Dinner"
  const prefixLower = meal.toLowerCase();

  // 4️⃣ Generate images via WaveSpeed directly
  console.log('🖼️ Generating meal image via WaveSpeed...');
  const [mealImage, step1Image, step5Image, step9Image] = await Promise.all([
    generateWaveSpeedImage(mealData.image_prompts.food),
    generateWaveSpeedImage(mealData.image_prompts.step_1),
    generateWaveSpeedImage(mealData.image_prompts.step_5),
    generateWaveSpeedImage(mealData.image_prompts.step_9),
  ]);

  const instructionImages = [step1Image, step5Image, step9Image].filter(Boolean);
  console.log(`✅ WaveSpeed: meal image ${mealImage ? '✓' : '✗'}, instruction images: ${instructionImages.length}/3`);

  // 5️⃣ Build the fields to update — matching your exact Firestore field naming convention
  const mealFields = {
    [`${prefix}Name`]: mealData.name ?? foodName,
    [`${prefix}Description`]: mealData.description ?? '',
    [`${prefix}Ingredients`]: (mealData.ingredients_used ?? []).map(String),
    [`MissingIngredients${prefix}`]: (mealData.missing_ingredients ?? []).map(String),
    [`${prefix}Instructions`]: (mealData.instructions ?? []).map(String),
    [`${prefix}Equipment`]: (mealData.equipment ?? []).map(String),
    [`${prefixLower}cost`]: Number(mealData.estimated_cost) || 0,
    [`${prefix}Image`]: mealImage ?? '',
    [`${prefix === 'Breakfast' ? 'BreakFast' : prefix}InstructionImages`]: instructionImages,
  };

  // 6️⃣ Update Firestore — only the specific meal fields under the specific day
  console.log(`💾 Updating Firestore: ${docPath} → ${day}.${prefix}*`);
  await firestoreMergeUpdate(docPath, day, mealFields, token);

  console.log(`✅ Done! ${dayMeal} (${foodName}) successfully updated in ${docPath}`);
}

// ---------------- EXPORT ----------------
module.exports = { updateSingleMeal };

const express = require('express');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

app.post('/update-meal', async (req, res) => {
  const { foodName, dayMeal, docRef } = req.body;
  if (!foodName || !dayMeal || !docRef) {
    return res.status(400).json({ error: 'foodName, dayMeal, and docRef are required' });
  }
  res.json({ message: 'Meal update started', dayMeal, foodName });
  updateSingleMeal(foodName, dayMeal, docRef).catch(console.error);
});

app.get('/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, '0.0.0.0', () => console.log(`🍽️ Single meal updater running on port ${PORT}`));
