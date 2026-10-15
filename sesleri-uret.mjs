// Oyundaki tüm konuşmaları ElevenLabs ile BİR KEZ seslendirir, sesler/ klasörüne mp3 olarak kaydeder
// ve hijyen.html içine gömer. Daha önce indirilmiş sesler tekrar üretilmez (kota harcanmaz).
//
// Kullanım:  node sesleri-uret.mjs            -> sadece eksik sesleri üretir + sayfaya gömer
//            node sesleri-uret.mjs --sadece-gom -> hiç API çağırmaz, klasördekileri gömer
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
// yerelde hijyen.html, GitHub Pages reposunda index.html
const HTML = existsSync(join(ROOT, 'hijyen.html')) ? join(ROOT, 'hijyen.html') : join(ROOT, 'index.html');
const OUT = join(ROOT, 'sesler');
const ONLY_EMBED = process.argv.includes('--sadece-gom');

// ElevenLabs ücretsiz planda API'den yalnızca hazır sesler kullanılabiliyor
const VOICES = {
  kid: { id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica', settings: { stability: 0.35, similarity_boost: 0.8, style: 0.45, use_speaker_boost: true } },
  narrator: { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice', settings: { stability: 0.55, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true } }
};
const MODEL = 'eleven_multilingual_v2';

// sayfadaki voiceKey() ile birebir aynı olmalı
const voiceKey = (t) => t.replace(/[\p{Extended_Pictographic}️‍]/gu, '').replace(/\s+/g, ' ').trim();

function readApiKey() {
  const env = readFileSync(join(ROOT, '.env'), 'utf8');
  const m = env.match(/^\s*eleven_api_key\s*=\s*["']?([^"'\r\n]+)/im);
  if (!m) throw new Error('.env içinde eleven_api_key bulunamadı');
  return m[1].trim();
}

// konuşma cümlelerini oyunun kodundan çıkarır: INFO ve WASH_GUIDE -> anlatıcı, diğerleri -> çocuk
function extractLines(html) {
  const js = html.split('<script>').pop().split('</script>')[0];
  const block = (start, end) => {
    const i = js.indexOf(start);
    return i < 0 ? '' : js.slice(i, js.indexOf(end, i));
  };
  const narratorBlocks = [block('const INFO = {', '};'), block('const WASH_GUIDE = [', '];')];
  const literals = (src) => [...src.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map((m) => m[1]);
  const isSpeech = (s) => /\s/.test(s) && /[.!?…]$/.test(voiceKey(s)) && !/[#<>{}$=()]/.test(s);
  const narrator = [...new Set(narratorBlocks.flatMap(literals).filter(isSpeech).map(voiceKey))];
  const kidSrc = narratorBlocks.reduce((src, b) => (b ? src.replace(b, '') : src), js);
  const kid = [...new Set(literals(kidSrc).filter(isSpeech).map(voiceKey))]
    .filter((t) => !narrator.includes(t));
  return { kid, narrator };
}

const fileFor = (role, text) =>
  join(OUT, `${role}-${createHash('sha1').update(`${VOICES[role].id}|${MODEL}|${text}`).digest('hex').slice(0, 12)}.mp3`);

async function tts(apiKey, role, text) {
  const { id, settings } = VOICES[role];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${id}?output_format=mp3_44100_64`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: MODEL, voice_settings: settings })
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const body = await res.text();
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 3000 * attempt));
      continue;
    }
    throw new Error(`ElevenLabs ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const html = readFileSync(HTML, 'utf8');
  const lines = extractLines(html);
  const jobs = [
    ...lines.kid.map((text) => ({ role: 'kid', text })),
    ...lines.narrator.map((text) => ({ role: 'narrator', text }))
  ];
  const missing = jobs.filter((j) => !existsSync(fileFor(j.role, j.text)));
  const chars = missing.reduce((n, j) => n + j.text.length, 0);
  console.log(`${jobs.length} cümle (çocuk ${lines.kid.length}, anlatıcı ${lines.narrator.length}); eksik ${missing.length} (${chars} karakter)`);

  if (missing.length && !ONLY_EMBED) {
    const apiKey = readApiKey();
    for (const j of missing) {
      const mp3 = await tts(apiKey, j.role, j.text);
      writeFileSync(fileFor(j.role, j.text), mp3);
      console.log(`  ✓ ${VOICES[j.role].name}: ${j.text}`);
    }
  }

  const voices = {};
  const manifest = [];
  for (const j of jobs) {
    const file = fileFor(j.role, j.text);
    if (!existsSync(file)) {
      console.warn(`  ! ses yok: ${j.text}`);
      continue;
    }
    voices[j.text] = `data:audio/mpeg;base64,${readFileSync(file).toString('base64')}`;
    manifest.push({ role: j.role, voice: VOICES[j.role].name, text: j.text, file: file.slice(ROOT.length + 1) });
  }
  writeFileSync(join(OUT, 'liste.json'), JSON.stringify(manifest, null, 2));

  const block = `<script id="voices">window.VOICES=${JSON.stringify(voices)};</script>\n`;
  const cleaned = html.replace(/<script id="voices">[\s\S]*?<\/script>\n?/, '');
  const at = cleaned.lastIndexOf('<script>');
  writeFileSync(HTML, cleaned.slice(0, at) + block + cleaned.slice(at));
  console.log(`${Object.keys(voices).length} ses ${HTML.slice(ROOT.length + 1)} içine gömüldü.`);
}

main().catch((err) => {
  console.error('Seslendirme başarısız:', err.message);
  process.exit(1);
});
