// server.js
// سيرفر بسيط: بياخد لينك تيك توك/انستجرام/فيسبوك/يوتيوب، بينزل الفيديو بـ yt-dlp،
// بيستخرج منه فريمات بـ ffmpeg، وبيرجعها JSON عشان أداة التحليل (الفرونت اند) تستخدمها.
//
// محتاج على السيرفر: yt-dlp + ffmpeg متثبتين (الـ Dockerfile المرفق بيعملهم أوتوماتيك).

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const app = express();
app.use(cors()); // مفتوح للكل عشان الفرونت اند يقدر يوصله من أي دومين. ضيّقها لو عايز أمان أكتر.
app.use(express.json({ limit: '30mb' })); // الفريمات base64 ممكن تبقى تقيلة نسبيًا

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; // لازم تحطه في إعدادات الاستضافة (Environment Variables)
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'; // راجع docs.anthropic.com/en/docs/about-claude/models لأحدث اسم موديل
const MAX_DURATION_SECONDS = 240; // حماية: منرفضش نحمل فيديوهات أطول من 4 دقايق
const DOWNLOAD_TIMEOUT_MS = 90_000;
const ALLOWED_HOST_FRAGMENTS = [
  'tiktok.com', 'vm.tiktok.com',
  'instagram.com',
  'facebook.com', 'fb.watch',
  'youtube.com', 'youtu.be'
];

function isAllowedUrl(url) {
  try {
    const u = new URL(url);
    return ALLOWED_HOST_FRAGMENTS.some(h => u.hostname.endsWith(h));
  } catch {
    return false;
  }
}

function runCommand(cmd, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Command timed out: ${cmd}`));
    }, timeoutMs);

    proc.stdout.on('data', d => (stdout += d.toString()));
    proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('error', err => { clearTimeout(timer); reject(err); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `${cmd} exited with code ${code}`));
    });
  });
}

async function ffprobeDuration(filePath) {
  const { stdout } = await runCommand('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ]);
  const dur = parseFloat(stdout.trim());
  return isFinite(dur) ? dur : 0;
}

async function extractFrameAt(filePath, timeSec, outPath) {
  await runCommand('ffmpeg', [
    '-ss', String(timeSec),
    '-i', filePath,
    '-frames:v', '1',
    '-vf', 'scale=420:-2',
    '-q:v', '4',
    '-y',
    outPath
  ], { timeoutMs: 20_000 });
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/extract', async (req, res) => {
  const { url } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'ابعت لينك صحيح في الحقل url' });
  }
  if (!isAllowedUrl(url)) {
    return res.status(400).json({ error: 'اللينك ده مش من تيك توك/انستجرام/فيسبوك/يوتيوب' });
  }

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'viral-'));
  const videoTemplate = path.join(workDir, 'video.%(ext)s');

  try {
    // 1) نزّل الفيديو بأقل جودة معقولة عشان يبقى سريع (mp4، أقصى ارتفاع 720)
    await runCommand('yt-dlp', [
      '-f', 'mp4[height<=720]/best[height<=720]/best',
      '--no-playlist',
      '--max-filesize', '80M',
      '-o', videoTemplate,
      url
    ], { timeoutMs: DOWNLOAD_TIMEOUT_MS });

    const files = await fsp.readdir(workDir);
    const videoFile = files.find(f => f.startsWith('video.'));
    if (!videoFile) throw new Error('yt-dlp مقدرش ينزل الفيديو (ممكن يكون خاص أو محذوف)');
    const videoPath = path.join(workDir, videoFile);

    // 2) اقرأ مدة الفيديو
    const duration = await ffprobeDuration(videoPath);
    if (duration <= 0) throw new Error('متقدرش أقرا مدة الفيديو');
    if (duration > MAX_DURATION_SECONDS) {
      throw new Error(`الفيديو طويل أكتر من ${MAX_DURATION_SECONDS / 60} دقايق، مش مدعوم دلوقتي`);
    }

    // 3) حدد توقيتات الفريمات: هوك (أول ثانيتين) + فريمات موزعة
    const times = [0.1, 0.6, 1.2, Math.min(2.0, duration - 0.1)];
    const spreadCount = 5;
    for (let i = 1; i <= spreadCount; i++) {
      times.push(Math.min(duration - 0.1, (duration / (spreadCount + 1)) * i));
    }
    const uniqueTimes = [...new Set(times.map(t => Math.max(0, Number(t.toFixed(2)))))];

    // 4) استخرج كل فريم كـ jpg وحوّله base64
    const frames = [];
    for (const t of uniqueTimes) {
      const outPath = path.join(workDir, `f_${t}.jpg`);
      await extractFrameAt(videoPath, t, outPath);
      const buf = await fsp.readFile(outPath);
      frames.push({ time: t, base64: buf.toString('base64') });
    }

    res.json({ duration, frames });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'حصل خطأ أثناء تحميل أو تحليل الفيديو' });
  } finally {
    // نضّف الملفات المؤقتة
    fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.post('/api/analyze', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'السيرفر لسه مفيهوش ANTHROPIC_API_KEY. ضيفه من إعدادات الاستضافة (Environment Variables) وبعدين اعمل Redeploy.' });
  }

  const { frames = [], script = '', link = '' } = req.body || {};
  if (!frames.length && !script.trim()) {
    return res.status(400).json({ error: 'ابعت فريمات أو سكريبت على الأقل' });
  }

  const imageBlocks = frames.map(f => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: f.base64 }
  }));

  const promptText = `انت خبير تحليل محتوى فيروسي (Viral Content Analyst) متخصص في الريلز والتيك توك والشورتس، بتحلل فيديوهات لصناع محتوى محترفين وبتديهم تقرير دقيق وعملي.

هحطلك فريمات مأخوذة من فيديو (أول ٤ فريمات من أول ثانيتين وبيمثلوا الـ hook، والباقي موزع على طول الفيديو)${script ? '، وكمان السكريبت الكامل اللي بيتقال في الفيديو' : ' (من غير سكريبت لأن المستخدم ملحقش يبعته — حلل الفيجوالز والإيديت بس واذكر إن السكريبت مش متاح)'}.
${link ? 'لينك مرجعي للفيديو (للسياق بس، متقدرش تفتحه): ' + link : ''}

المطلوب تحليل شامل ومقسّم:

1. الهوك (أول ٣ ثواني): سكور من ١٠٠، وهل شادّ بصريًا وبالكلام، واقترح هوك بديل أقوى وأكتر تحديدًا.
2. السكريبت الكامل — قسّمه لثلاث مراحل وحلل كل مرحلة على حدة:
   - Hook: أول جملة/جمل
   - Body: بناء المحتوى والمعلومة/القصة وهل فيه إيقاع يحافظ على الاهتمام
   - CTA: الخاتمة ودعوة التفاعل
   لكل مرحلة اكتب سطر أو اتنين تقييم. وبعدين اذكر نقط القوة والضعف العامة للسكريبت.
3. الإيديت والتمبو: من تنوع الفريمات، قدّر معدل القطع (سريع جدًا / متوسط / بطيء) ومستوى "الإزعاج" (منخفض/متوسط/مرتفع) - يعني هل الفيديو حيحس المشاهد إنه ثابت ومملّ، أو سريع ومقطّع بشكل متعب.
4. الفيجوالز: حلل الإضاءة والتكوين لوحده، الكولور جريدنج لوحده، والتكست أوفرلاي/التكست هوك الظاهر في الفريمات لوحده (وضوحه، توقيته، قوته كخطاف بصري).
5. الشخص/المتحدث الظاهر في الفريمات (لو موجود): قيّم الحضور الكاميرا، الطاقة الظاهرة في تعابير الوجه ولغة الجسد، والثقة الظاهرة. لو مفيش شخص ظاهر (فويس اوفر بس أو محتوى بدون شخص) اذكر ده بوضوح ومتقيّمش حاجة مش موجودة.
6. جودة التصوير: ثبات الكاميرا (هل في اهتزاز واضح من الفريمات)، الفريمنج والتكوين، جودة/دقة الصورة العامة، هل في مشاكل واضحة زي فوكس غير واضح أو تقطيع سيء في الحواف.
7. تحليل الريتنشن: بناءً على السكريبت والفريمات، حدد أماكن محددة (بالثانية أو بالمرحلة) ممكن المشاهد يسيب الفيديو عندها - زي جملة بطيئة، فجوة فضول ضايعة، معلومة اتقالت بدري قوي، أو لحظة مفيهاش تغيير بصري لفترة طويلة. اديني قائمة نقط خطر محددة، مش كلام عام.
8. سكور فيرالية عام من ١٠٠ وحكم مختصر بالعامية المصرية.
9. من ٥ لـ ٧ اقتراحات تحسين عملية جدًا ومباشرة، كل واحدة تقدر تتنفذ فورًا.

${script ? 'السكريبت:\n' + script : ''}

رجاءً رد بصيغة JSON فقط، بدون أي نص أو markdown قبل أو بعد، بالشكل ده بالظبط:
{
  "viral_score": number,
  "verdict": "حكم قصير بالعامية المصرية",
  "hook": {"score": number, "feedback": "...", "improved_hook_suggestion": "..."},
  "script": {
    "feedback": "...",
    "phases": {"hook": "...", "body": "...", "cta": "..."},
    "strengths": ["...", "..."],
    "weaknesses": ["...", "..."]
  },
  "editing": {"pacing_verdict": "سريع جدًا / متوسط / بطيء", "annoyance_risk": "منخفض / متوسط / مرتفع", "cut_frequency_estimate": "...", "feedback": "..."},
  "visuals": {"composition_lighting": "...", "color_grading": "...", "text_overlay_feedback": "..."},
  "presenter": {"present": true, "score": number, "feedback": "..."},
  "production_quality": {"feedback": "..."},
  "retention": {"feedback": "...", "risk_points": [{"time_or_phase": "...", "issue": "..."}]},
  "suggestions": ["...", "...", "...", "...", "..."]
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 2600,
        messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: promptText }] }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error?.message || `Anthropic API رجع status ${response.status}`);
    }
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) throw new Error('الرد مرجعش نص قابل للتحليل');
    const clean = textBlock.text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'حصل خطأ أثناء التحليل' });
  }
});

app.listen(PORT, () => {
  console.log(`Viral analyzer backend listening on port ${PORT}`);
});
