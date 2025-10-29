// === (نفس الاستيرادات السابقة تمامًا) ===
import 'dotenv/config';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import prettyMs from 'pretty-ms';
import {
  Client, GatewayIntentBits, Partials, EmbedBuilder, AttachmentBuilder,
  Events, PermissionsBitField, ChannelType
} from 'discord.js';
import {
  joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus,
  NoSubscriberBehavior, VoiceConnectionStatus, entersState, StreamType
} from '@discordjs/voice';
import play from 'play-dl';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === إعدادات/مجلدات ===
const CONFIG_PATH = path.join(__dirname, 'config.json');
const ASSETS_DIR = path.join(__dirname, 'assets');
const PLAYLISTS_DIR = path.join(__dirname, 'playlists');
await fs.ensureFile(CONFIG_PATH);
await fs.ensureDir(ASSETS_DIR);
await fs.ensureDir(PLAYLISTS_DIR);

const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
const TOKEN = process.env.TOKEN || config.token;
if (!TOKEN) { console.error('❌ ضع TOKEN في config.json أو .env'); process.exit(1); }

const API_BASE = config.apiBase?.replace(/\/+$/,'') || '';
const API_KEY  = config.apiKey || '';

// === عميل الديسكورد ===
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// === حالة التشغيل لكل سيرفر (نفس السابق) ===
const states = new Map();
function getState(gid) {
  if (!states.has(gid)) {
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    states.set(gid, {
      connection: null, player,
      queue: [], autoplay: false, loopOne: false,
      volume: 80, current: null,
      progressMsgId: null, progressChannelId: null,
      progressInterval: null, lastPlayedUrl: null
    });
  }
  return states.get(gid);
}

// === كاش الاشتراكات من الـAPI ===
const premiumCache = new Map(); // guildId -> { active, expiresAt, t:timestamp }
const CACHE_TTL = 4 * 60 * 1000; // 4 دقائق

async function fetchPremium(guildId, force=false) {
  const now = Date.now();
  const cached = premiumCache.get(guildId);
  if (!force && cached && (now - cached.t) < CACHE_TTL) return cached;

  if (!API_BASE) return { active:false, expiresAt:null, t:now };
  try {
    const res = await fetch(`${API_BASE}/v1/premium/${guildId}`, { method: 'GET' });
    const data = await res.json();
    const row = { active: !!data.active, expiresAt: data.expiresAt || null, t: now };
    premiumCache.set(guildId, row);
    return row;
  } catch {
    // في حالة فشل السيرفر، لا نقفل البوت فجأة؛ نرجع آخر قيمة كاش أو غير مفعل
    return cached || { active:false, expiresAt:null, t: now };
  }
}
function leftMs(expiresAt) {
  if (!expiresAt) return 0;
  return Math.max(0, new Date(expiresAt).getTime() - Date.now());
}

// === عند الانضمام لسيرفر جديد (تجربة تلقائية اختيارية محلية) ===
client.on(Events.GuildCreate, async (guild) => {
  const channel = guild.channels.cache.find(
    c => c.type === ChannelType.GuildText &&
    c.viewable && c.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.SendMessages)
  );
  if (channel) channel.send('👋 تم إضافة البوت. يتحقق من حالة الاشتراك تلقائيًا.').catch(()=>{});
});

// === أوامر المالك: تتصل بالـAPI مباشرة ===
client.on(Events.MessageCreate, async (msg) => {
  if (!msg.guild || msg.author.bot) return;
  if (msg.author.id !== String(config.ownerId)) return;
  const args = msg.content.trim().split(/\s+/);

  // !invite <days> (يبقى كما هو محليًا لو تريده – اختياري)
  if (args[0] === '!invite') {
    const days = Number(args[1]||0);
    if (!days) return msg.reply('اكتب: `!invite 30`');
    const link = `https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(config.clientId)}&permissions=36727872&scope=bot`;
    return msg.reply(`🔗 **Bot Invite**:\n${link}\n\nعند الانضمام استخدم لوحة التحكم لإضافة أيام للسيرفر الجديد.`);
  }

  // !addpremium <GuildID> <Days>  → يضرب /v1/premium/extend
  if (args[0] === '!addpremium') {
    const gid = args[1]; const days = Number(args[2]||0);
    if (!gid || !days) return msg.reply('الاستخدام: `!addpremium <GuildID> <Days>`');
    try {
      const res = await fetch(`${API_BASE}/v1/premium/extend`, {
        method: 'POST',
        headers: { 'content-type':'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ guildId: gid, days })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'API error');
      premiumCache.delete(gid); // حدّث الكاش
      return msg.reply(`✅ تم التمديد حتى: **${new Date(data.expiresAt).toLocaleString()}**`);
    } catch(e) {
      return msg.reply(`❌ فشل الاتصال بالـAPI: ${String(e.message||e)}`);
    }
  }

  // !setpremium <GuildID> <YYYY-MM-DD>
  if (args[0] === '!setpremium') {
    const gid = args[1]; const dateStr = args[2];
    if (!gid || !dateStr) return msg.reply('الاستخدام: `!setpremium <GuildID> <YYYY-MM-DD>`');
    try {
      const res = await fetch(`${API_BASE}/v1/premium/set`, {
        method: 'POST',
        headers: { 'content-type':'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ guildId: gid, expiresAt: new Date(dateStr).toISOString() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'API error');
      premiumCache.delete(gid);
      return msg.reply(`✅ تم التعيين إلى: **${new Date(data.expiresAt).toLocaleString()}**`);
    } catch(e) {
      return msg.reply(`❌ فشل الاتصال بالـAPI: ${String(e.message||e)}`);
    }
  }

  // !checkpremium [GuildID]
  if (args[0] === '!checkpremium') {
    const gid = args[1] || msg.guild.id;
    const info = await fetchPremium(gid, true);
    const left = leftMs(info.expiresAt);
    return msg.reply(
      info.active
        ? `✅ Premium: فعال — ينتهي: **${new Date(info.expiresAt).toLocaleString()}** — متبقّي: **${prettyMs(left, { unitCount:2 })}**`
        : '🚫 غير مشترك حاليًا.'
    );
  }
});

// === أوامر المستخدم (بدون سلاش) — نفس الإصدار v2: ش/س/وقف/اوتو/ق/تكرار/رفع/خفض/حفظ/تحميل ===
client.on(Events.MessageCreate, async (msg) => {
  if (!msg.guild || msg.author.bot) return;
  const content = msg.content.trim();

  if (content.startsWith('ش ')) return handlePlay(msg, content.slice(2).trim());
  if (content === 'س') return handleSkip(msg);
  if (content === 'وقف') return handleStop(msg);
  if (content === 'اوتو') return handleAutoplay(msg);
  if (content === 'ق') return handleQueue(msg);
  if (content === 'تكرار') return handleLoop(msg);
  if (content === 'رفع') return handleVolume(msg, +10);
  if (content === 'خفض') return handleVolume(msg, -10);
  if (content.startsWith('حفظ ')) return handleSavePlaylist(msg, content.slice(4).trim());
  if (content.startsWith('تحميل ')) return handleLoadPlaylist(msg, content.slice(6).trim());
});

// === نقطة تحقق الاشتراك (Embed) قبل التشغيل ===
async function ensurePremiumOrReply(msg, guildId) {
  const info = await fetchPremium(guildId);
  if (info.active) return { ok: true, info };
  const left = leftMs(info.expiresAt);

  const embed = new EmbedBuilder()
    .setColor('#ED4245')
    .setTitle('🚫 السيرفر غير مشترك')
    .setDescription(left > 0
      ? `⏳ متبقّي: **${prettyMs(left, { unitCount: 1 })}**\n💬 تواصل مع الإدارة لتفعيل الاشتراك.`
      : `💬 تواصل مع الإدارة لتفعيل الاشتراك.`)
    .setFooter({ text: `نظام الاشتراكات • ${msg.guild.name}` })
    .setTimestamp();

  await msg.channel.send({ content: `<@${msg.author.id}>`, embeds: [embed] });
  return { ok: false };
}

// === … بقية دوال التشغيل نفسها من الإصدار v2 (playNext, progress bar, embeds، الخ) ===
// أهم فرق: استدعِ ensurePremiumOrReply() في بداية handlePlay

async function handlePlay(msg, query) {
  if (!query) return msg.reply('اكتب اسم الأغنية أو الرابط بعد الأمر: `ش اسم الاغنية`');
  const prem = await ensurePremiumOrReply(msg, msg.guild.id);
  if (!prem.ok) return;

  const vc = msg.member?.voice?.channel;
  if (!vc) return msg.reply('ادخل روم صوتي أولًا 🎧');

  const st = getState(msg.guild.id);
  if (!st.connection || st.connection.state.status !== VoiceConnectionStatus.Ready) {
    st.connection = joinVoiceChannel({ channelId: vc.id, guildId: vc.guild.id, adapterCreator: vc.guild.voiceAdapterCreator });
    try { await entersState(st.connection, VoiceConnectionStatus.Ready, 15_000); }
    catch { return msg.reply('تعذّر الاتصال بالروم الصوتي.'); }
  }

  // (بحث/إضافة للكيو والتشغيل) — نفس كود الإصدار v2 الذي أرسلته لك
  // … اكمل بنفس الدوال السابقة: play.search/stream + playNext + progress bar + embeds
}

// الدوال: playNext, startProgressUpdater, stopProgressUpdater, progressBar, buildNowPlayingEmbed,
// handleSkip/Stop/Autoplay/Queue/Loop/Volume/SavePlaylist/LoadPlaylist
// (انسخها كما في الإصدار v2 السابق دون تغيير)
client.once(Events.ClientReady, () => console.log(`✅ Logged in as ${client.user.tag}`));
client.login(TOKEN);
