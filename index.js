'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const config = require('./config');

const {
  addLootboxCommand,
  createLootbox,
} = require('./lootbox');

// ============================================================
// STOCKAGE ET RÈGLES DES JEUX
// ============================================================

const {
  Store,
  Engine,
  parisDate,
  id,
  validateQuestions,
} = (() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const { randomBytes, randomInt } = require('node:crypto');
  const config = require('./config');

  const id = () => randomBytes(9).toString('hex');

  const fail = message => {
    throw new Error(message);
  };

  const normal = s =>
    String(s)
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/&/g, ' et ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  const parisDay = (now = Date.now()) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Paris',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);

  function parisDate(s) {
    const m =
      /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s || '');

    if (!m) {
      fail('Date attendue : AAAA-MM-JJ HH:mm, heure de Paris.');
    }

    const utc = Date.UTC(
      +m[1],
      +m[2] - 1,
      +m[3],
      +m[4],
      +m[5]
    );

    const fmt = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Paris',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });

    const found = [
      utc - 3600000,
      utc - 7200000,
    ].filter(t => fmt.format(t) === s);

    if (found.length !== 1) {
      fail(
        'Date invalide ou heure ambiguë au changement d’heure. ' +
        'Choisis une autre heure.'
      );
    }

    return found[0];
  }

  function validateQuestions(q) {
    if (
      !Array.isArray(q) ||
      q.length < 1 ||
      q.length > 30
    ) {
      fail('Le quiz doit contenir entre 1 et 30 questions.');
    }

    for (const x of q) {
      if (
        typeof x.question !== 'string' ||
        !x.question.trim() ||
        x.question.length > 500 ||
        !Array.isArray(x.choices) ||
        x.choices.length < 2 ||
        x.choices.length > 4 ||
        x.choices.some(
          c =>
            typeof c !== 'string' ||
            !c.trim() ||
            c.length > 80
        ) ||
        !Number.isInteger(x.answer) ||
        x.answer < 0 ||
        x.answer >= x.choices.length ||
        (
          x.explanation &&
          (
            typeof x.explanation !== 'string' ||
            x.explanation.length > 700
          )
        )
      ) {
        fail(
          'Question invalide : question, choices (2 à 4 réponses), ' +
          'answer (index à partir de 0), explanation facultative.'
        );
      }
    }

    return q;
  }

  class Store {
    constructor(dir) {
      fs.mkdirSync(dir, {
        recursive: true,
        mode: 0o700,
      });

      this.dir = dir;

      this.db = new DatabaseSync(
        path.join(dir, 'sacem.sqlite')
      );

      this.db.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        PRAGMA busy_timeout=5000;

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS activities (
          id TEXT PRIMARY KEY,
          json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          activity TEXT,
          user TEXT,
          json TEXT NOT NULL,
          PRIMARY KEY(activity,user)
        );

        CREATE TABLE IF NOT EXISTS ledger (
          key TEXT PRIMARY KEY,
          season TEXT NOT NULL,
          user TEXT NOT NULL,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          points INTEGER NOT NULL,
          created INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS ledger_season
          ON ledger(season,user);
      `);

      if (!this.setting('season')) {
        this.setting('season', 'Saison 1');
      }
    }

    setting(k, v) {
      if (v !== undefined) {
        this.db.prepare(`
          INSERT INTO settings VALUES(?,?)
          ON CONFLICT(key)
          DO UPDATE SET json=excluded.json
        `).run(k, JSON.stringify(v));
      }

      const r = this.db
        .prepare('SELECT json FROM settings WHERE key=?')
        .get(k);

      return r ? JSON.parse(r.json) : null;
    }

    activity(activityId) {
      const r = this.db
        .prepare('SELECT json FROM activities WHERE id=?')
        .get(activityId);

      if (!r) {
        fail('Animation introuvable.');
      }

      return JSON.parse(r.json);
    }

    all() {
      return this.db
        .prepare('SELECT json FROM activities')
        .all()
        .map(r => JSON.parse(r.json));
    }

    save(a) {
      this.db.prepare(`
        INSERT INTO activities VALUES(?,?)
        ON CONFLICT(id)
        DO UPDATE SET json=excluded.json
      `).run(
        a.id,
        JSON.stringify(a)
      );

      return a;
    }

    session(a, u) {
      const r = this.db.prepare(`
        SELECT json FROM sessions
        WHERE activity=? AND user=?
      `).get(a, u);

      return r ? JSON.parse(r.json) : null;
    }

    saveSession(s) {
      this.db.prepare(`
        INSERT INTO sessions VALUES(?,?,?)
        ON CONFLICT(activity,user)
        DO UPDATE SET json=excluded.json
      `).run(
        s.activity,
        s.user,
        JSON.stringify(s)
      );

      return s;
    }

    count(a) {
      return this.db
        .prepare(
          'SELECT count(*) n FROM sessions WHERE activity=?'
        )
        .get(a).n;
    }

    tx(fn) {
      this.db.exec('BEGIN IMMEDIATE');

      try {
        const x = fn();
        this.db.exec('COMMIT');
        return x;
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }

    award(key, a, user, name, points, now) {
      return this.db.prepare(`
        INSERT OR IGNORE INTO ledger
        VALUES(?,?,?,?,?,?,?)
      `).run(
        key,
        a.season,
        user,
        name,
        a.kind,
        points,
        now
      ).changes;
    }

    ranking(season = this.setting('season')) {
      const r = this.db.prepare(`
        SELECT user, max(name) name, sum(points) points
        FROM ledger
        WHERE season=?
        GROUP BY user
        ORDER BY points DESC,user ASC
      `).all(season);

      r.forEach((x, i) => {
        x.rank =
          i && r[i - 1].points === x.points
            ? r[i - 1].rank
            : i + 1;
      });

      return r;
    }
  }

  class Engine {
    constructor(store, now = () => Date.now()) {
      this.store = store;
      this.now = now;
    }

    create(data) {
      if (
        !data.title?.trim() ||
        data.title.length > 150 ||
        !['blind', 'artist', 'quiz'].includes(data.kind) ||
        !Number.isFinite(data.open) ||
        !Number.isFinite(data.close) ||
        data.close <= data.open ||
        data.close <= this.now()
      ) {
        fail(
          'Vérifie le titre et les dates de publication/clôture.'
        );
      }

      if (data.kind === 'quiz') {
        validateQuestions(data.questions);
      } else if (
        !Array.isArray(data.answers) ||
        !data.answers.some(x => normal(x))
      ) {
        fail('Renseigne au moins une réponse acceptée.');
      }

      return this.store.save({
        ...data,
        id: data.id || id(),
        season: this.store.setting('season'),
        status: 'scheduled',
        message: null,
        revealed: false,
        created: this.now(),
        rules: structuredClone(config[data.kind]),
        error: null,
      });
    }

    open(a) {
      if (
        a.status !== 'published' ||
        this.now() < a.open ||
        this.now() >= a.close
      ) {
        fail(config.text.late);
      }
    }

    refresh(a, s) {
      if (
        s.phase === 'playing' &&
        this.now() >= s.deadline
      ) {
        if (a.kind === 'quiz') {
          s.phase = 'feedback';

          s.last = {
            correct: false,
            timeout: true,
            points: 0,
            answer: a.questions[s.index].answer,
          };
        } else {
          s.phase =
            s.stage < 2
              ? 'timeout'
              : 'finished';
        }

        this.store.saveSession(s);
      }

      return s;
    }

    start(aid, user, name) {
      return this.store.tx(() => {
        const a = this.store.activity(aid);
        this.open(a);

        let s = this.store.session(aid, user);

        if (s) {
          return this.refresh(a, s);
        }

        const now = this.now();

        const duration =
          a.kind === 'blind'
            ? a.rules.durations[0] * 1000
            : 0;

        s = {
          activity: aid,
          user,
          name: name.slice(0, 80),
          stage: 0,
          index: 0,
          phase: 'playing',
          points: 0,
          history: [],
          started: now,
          available: now + duration,

          deadline:
            now +
            duration +
            (
              a.kind === 'quiz'
                ? a.rules.seconds
                : a.rules.answerSeconds
            ) * 1000,
        };

        this.store.award(
          `participation:${aid}:${user}`,
          a,
          user,
          s.name,
          0,
          now
        );

        return this.store.saveSession(s);
      });
    }

    get(aid, user) {
      const a = this.store.activity(aid);
      const s = this.store.session(aid, user);

      if (!s) {
        fail('Commence par le bouton Participer.');
      }

      return this.store.tx(() =>
        this.refresh(a, s)
      );
    }

    stage(aid, user, expected) {
      return this.store.tx(() => {
        const a = this.store.activity(aid);
        this.open(a);

        const s = this.store.session(aid, user);

        if (!s) {
          fail('Participation introuvable.');
        }

        this.refresh(a, s);

        if (
          a.kind === 'quiz' ||
          s.stage !== expected ||
          !['playing', 'timeout'].includes(s.phase)
        ) {
          fail(
            'Ce palier est déjà terminé. ' +
            'Reprends depuis le message de l’animation.'
          );
        }

        if (this.now() < s.available) {
          fail(
            'Attends la durée de l’extrait avant de passer au suivant.'
          );
        }

        if (s.stage === 2) {
          s.phase = 'finished';
          return this.store.saveSession(s);
        }

        s.stage++;
        s.phase = 'playing';
        s.started = this.now();

        s.available =
          this.now() +
          (
            a.kind === 'blind'
              ? a.rules.durations[s.stage] * 1000
              : 0
          );

        s.deadline =
          s.available +
          a.rules.answerSeconds * 1000;

        return this.store.saveSession(s);
      });
    }

    answer(aid, user, expected, input) {
      return this.store.tx(() => {
        const a = this.store.activity(aid);
        this.open(a);

        const s = this.store.session(aid, user);

        if (!s) {
          fail('Participation introuvable.');
        }

        this.refresh(a, s);

        if (
          a.kind === 'quiz' ||
          s.phase !== 'playing' ||
          s.stage !== expected
        ) {
          fail(
            'Réponse déjà enregistrée ou délai dépassé.'
          );
        }

        const correct = a.answers.some(
          x => normal(x) === normal(input)
        );

        s.phase = 'finished';
        s.result = correct ? 'correct' : 'wrong';

        s.points = correct
          ? a.rules.points[s.stage]
          : 0;

        s.history.push({
          stage: s.stage,
          correct,
          answer: String(input).slice(0, 250),
        });

        if (correct) {
          this.store.award(
            `a:${aid}:${user}`,
            a,
            user,
            s.name,
            s.points,
            this.now()
          );
        }

        return this.store.saveSession(s);
      });
    }

    quizAnswer(aid, user, index, choice) {
      return this.store.tx(() => {
        const a = this.store.activity(aid);
        this.open(a);

        const s = this.store.session(aid, user);

        if (!s) {
          fail('Participation introuvable.');
        }

        this.refresh(a, s);

        if (
          a.kind !== 'quiz' ||
          s.index !== index ||
          s.phase !== 'playing'
        ) {
          fail(
            'Réponse déjà enregistrée ou temps écoulé. ' +
            'Utilise la dernière question.'
          );
        }

        const q = a.questions[index];

        if (
          !Number.isInteger(choice) ||
          choice < 0 ||
          choice >= q.choices.length
        ) {
          fail('Choix invalide.');
        }

        const correct = choice === q.answer;
        const elapsed = this.now() - s.started;

        const points = correct
          ? Math.max(
              a.rules.minPoints,
              Math.round(
                a.rules.maxPoints -
                (
                  a.rules.maxPoints -
                  a.rules.minPoints
                ) *
                elapsed /
                (a.rules.seconds * 1000)
              )
            )
          : 0;

        s.phase = 'feedback';

        s.last = {
          correct,
          points,
          answer: q.answer,
          timeout: false,
        };

        s.points += points;

        s.history.push({
          index,
          choice,
          correct,
          points,
          elapsed,
        });

        if (correct) {
          this.store.award(
            `q:${aid}:${user}:${index}`,
            a,
            user,
            s.name,
            points,
            this.now()
          );
        }

        return this.store.saveSession(s);
      });
    }

    quizNext(aid, user, index) {
      return this.store.tx(() => {
        const a = this.store.activity(aid);
        this.open(a);

        const s = this.store.session(aid, user);

        if (!s) {
          fail('Participation introuvable.');
        }

        this.refresh(a, s);

        if (
          a.kind !== 'quiz' ||
          s.index !== index ||
          s.phase !== 'feedback'
        ) {
          fail(
            'Cette question n’est pas terminée ' +
            'ou le bouton est ancien.'
          );
        }

        if (s.last?.timeout) {
          s.history.push({
            index,
            correct: false,
            timeout: true,
            points: 0,
          });
        }

        s.index++;
        s.last = null;

        if (s.index >= a.questions.length) {
          s.phase = 'finished';
        } else {
          s.phase = 'playing';
          s.started = this.now();
          s.available = s.started;

          s.deadline =
            s.started +
            a.rules.seconds * 1000;
        }

        return this.store.saveSession(s);
      });
    }

    loot(user, name) {
      return this.store.tx(() => {
        const season =
          this.store.setting('season');

        const key =
          `loot:${season}:${parisDay(this.now())}:${user}`;

        if (
          this.store.db
            .prepare(
              'SELECT key FROM ledger WHERE key=?'
            )
            .get(key)
        ) {
          fail(
            'Tu as déjà ouvert ton coffre du jour. ' +
            'Reviens demain, heure de Paris.'
          );
        }

        const total = config.loot.reduce(
          (s, x) => s + x.weight,
          0
        );

        let n = randomInt(total);
        let points = 0;

        for (const x of config.loot) {
          if (n < x.weight) {
            points = x.points;
            break;
          }

          n -= x.weight;
        }

        this.store.award(
          key,
          {
            season,
            kind: 'loot',
          },
          user,
          name,
          points,
          this.now()
        );

        return points;
      });
    }
  }

  return {
    Store,
    Engine,
    normal,
    parisDay,
    parisDate,
    validateQuestions,
    id,
  };
})();

// ============================================================
// AUDIO, IMAGES ET BANNIÈRES
// ============================================================

const {
  download,
  prepare,
  banner,
} = (() => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const sharp = require('sharp');
  const config = require('./config');

  const run = promisify(execFile);

  async function download(
    url,
    max = 25 * 1024 * 1024
  ) {
    for (
      let redirects = 0;
      redirects < 4;
      redirects++
    ) {
      const u = new URL(url);

      if (
        u.protocol !== 'https:' ||
        ![
          'cdn.discordapp.com',
          'media.discordapp.net',
        ].includes(u.hostname)
      ) {
        throw new Error(
          'Joins le fichier directement dans la commande Discord.'
        );
      }

      const r = await fetch(u, {
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
      });

      if (
        r.status >= 300 &&
        r.status < 400
      ) {
        url = new URL(
          r.headers.get('location'),
          u
        ).href;

        continue;
      }

      if (!r.ok) {
        throw new Error(
          'Impossible de télécharger la pièce jointe Discord.'
        );
      }

      if (
        +r.headers.get('content-length') > max
      ) {
        throw new Error('Fichier trop volumineux.');
      }

      const chunks = [];
      let total = 0;

      for await (const chunk of r.body) {
        total += chunk.length;

        if (total > max) {
          await r.body.cancel().catch(() => {});

          throw new Error(
            'Fichier trop volumineux.'
          );
        }

        chunks.push(chunk);
      }

      return Buffer.concat(chunks);
    }

    throw new Error(
      'Trop de redirections sur la pièce jointe.'
    );
  }

  async function prepare(
    kind,
    activityId,
    attachment,
    offset,
    dir
  ) {
    if (!attachment) {
      throw new Error(
        'Ajoute une pièce jointe audio ou photo.'
      );
    }

    const folder = path.join(
      dir,
      'assets',
      activityId
    );

    await fs.mkdir(folder, {
      recursive: true,
      mode: 0o700,
    });

    const bytes = await download(
      attachment.url
    );

    const files = [];

    try {
      if (kind === 'artist') {
        const image = await sharp(bytes, {
          limitInputPixels: 30000000,
        })
          .rotate()
          .resize(960, 640, {
            fit: 'cover',
          })
          .removeAlpha()
          .png()
          .toBuffer();

        for (let i = 0; i < 3; i++) {
          const small =
            config.artist.pixels[i];

          const file = path.join(
            folder,
            `portrait-${i}.png`
          );

          await sharp(image)
            .resize(
              small,
              Math.round(small * 2 / 3)
            )
            .resize(960, 640, {
              kernel: 'nearest',
            })
            .blur(config.artist.sigma[i])
            .png()
            .toFile(file);

          files.push(file);
        }

        const original = path.join(
          folder,
          'solution.png'
        );

        await fs.writeFile(
          original,
          image
        );

        return {
          files,
          original,
        };
      }

      const source = path.join(
        folder,
        'source'
      );

      await fs.writeFile(
        source,
        bytes
      );

      let probe = '';

      try {
        await run(
          process.env.FFMPEG_PATH || 'ffmpeg',
          [
            '-hide_banner',
            '-protocol_whitelist',
            'file,pipe',
            '-i',
            source,
          ],
          {
            timeout: 15000,
            maxBuffer: 1024 * 1024,
          }
        );
      } catch (e) {
        probe = e.stderr || '';

        if (e.code === 'ENOENT') {
          throw new Error(
            'FFmpeg manque : utilise le Dockerfile fourni sur Railway.'
          );
        }
      }

      const m =
        /Duration: (\d+):(\d+):([\d.]+)/.exec(probe);

      const length = m
        ? +m[1] * 3600 + +m[2] * 60 + +m[3]
        : 0;

      if (
        length <
        offset + Math.max(...config.blind.durations)
      ) {
        throw new Error(
          'Le fichier audio est trop court ' +
          'pour ce départ et les trois extraits.'
        );
      }

      for (let i = 0; i < 3; i++) {
        const file = path.join(
          folder,
          `extrait-${i}.mp3`
        );

        await run(
          process.env.FFMPEG_PATH || 'ffmpeg',
          [
            '-nostdin',
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-ss',
            String(offset),
            '-protocol_whitelist',
            'file,pipe',
            '-i',
            source,
            '-t',
            String(config.blind.durations[i]),
            '-map',
            '0:a:0',
            '-vn',
            '-map_metadata',
            '-1',
            '-ac',
            '1',
            '-ar',
            '44100',
            '-c:a',
            'libmp3lame',
            '-b:a',
            '128k',
            '-id3v2_version',
            '0',
            '-write_xing',
            '0',
            file,
          ],
          {
            timeout: 45000,
            maxBuffer: 1024 * 1024,
          }
        );

        files.push(file);
      }

      await fs.unlink(source);

      return { files };
    } catch (e) {
      await fs.rm(folder, {
        recursive: true,
        force: true,
      });

      throw e;
    }
  }

  const esc = s =>
    String(s).replace(
      /[&<>"']/g,
      c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      }[c])
    );

  async function banner(
    title,
    subtitle,
    progress = 0
  ) {
    title = esc(
      String(title).slice(0, 55)
    );

    subtitle = esc(
      String(subtitle).slice(0, 105)
    );

    let bars = '';

    for (let i = 0; i < 45; i++) {
      const h =
        25 + Math.abs(Math.sin(i * 1.8)) * 105;

      bars +=
        `<rect x="${65 + i * 19}" ` +
        `y="${230 - h / 2}" ` +
        `width="7" height="${h}" rx="3" ` +
        `fill="${i % 3 ? '#BBA0FF' : '#F3D574'}" ` +
        'opacity=".7"/>';
    }

    return sharp(
      Buffer.from(`
        <svg xmlns="http://www.w3.org/2000/svg"
             width="1000" height="340">
          <defs>
            <linearGradient id="b">
              <stop stop-color="#21153E"/>
              <stop offset="1" stop-color="#53317B"/>
            </linearGradient>
          </defs>

          <rect width="1000" height="340"
                rx="24" fill="url(#b)"/>

          <circle cx="950" cy="0" r="190"
                  fill="#A784DA" opacity=".12"/>

          <g font-family="DejaVu Sans,Arial,sans-serif">
            <text x="54" y="52"
                  fill="#D9C7FF" font-size="16"
                  letter-spacing="4">
              SACEM · LE STUDIO
            </text>

            <text x="54" y="106"
                  fill="#FFF" font-size="32"
                  font-weight="bold">
              ${title}
            </text>

            <text x="54" y="144"
                  fill="#D9C7FF" font-size="17">
              ${subtitle}
            </text>

            ${bars}

            <rect x="54" y="309"
                  width="892" height="6"
                  rx="3" fill="#88709E"/>

            <rect x="54" y="309"
                  width="${Math.max(0, Math.min(1, progress)) * 892}"
                  height="6" rx="3" fill="#ECDD83"/>
          </g>
        </svg>
      `)
    )
      .png()
      .toBuffer();
  }

  return {
    download,
    prepare,
    banner,
  };
})();

// ============================================================
// OUTILS DISCORD
// ============================================================

const row = (...x) =>
  new ActionRowBuilder().addComponents(x);

const btn = (
  customId,
  label,
  style = ButtonStyle.Secondary,
  emoji
) => {
  const b = new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(style);

  if (emoji) {
    b.setEmoji(emoji);
  }

  return b;
};

const emb = () =>
  new EmbedBuilder()
    .setColor(config.color)
    .setFooter({
      text: config.name,
    });

const safe = s =>
  String(s)
    .replace(/([\\`*_~|>])/g, '\\$1')
    .replace(/@/g, '@\u200b');

const kindName = {
  blind: '🎧 Blind test',
  artist: '👀 Qui est-ce ?',
  quiz: '🧠 Quiz',
};

const unix = t =>
  Math.floor(t / 1000);

const txtOpt = (
  o,
  name,
  description,
  required = false
) =>
  o.addStringOption(x =>
    x
      .setName(name)
      .setDescription(description)
      .setMaxLength(
        name === 'texte'
          ? 3000
          : name === 'titre'
            ? 150
            : name === 'reponses'
              ? 1500
              : 500
      )
      .setRequired(required)
  );

// ============================================================
// COMMANDES
// ============================================================

function commands() {
  const root = new SlashCommandBuilder()
    .setName('sacem')
    .setDescription(
      'Les animations et le classement SACEM'
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild
    );

  for (const [name, kind] of [
    ['blind', 'blind'],
    ['portrait', 'artist'],
    ['quiz', 'quiz'],
  ]) {
    root.addSubcommand(o => {
      o
        .setName(name)
        .setDescription(
          `Créer et programmer : ${kindName[kind]}`
        );

      txtOpt(
        o,
        'titre',
        'Titre public de l’animation',
        true
      );

      o.addChannelOption(x =>
        x
          .setName('salon')
          .setDescription('Salon où publier')
          .addChannelTypes(0)
          .setRequired(true)
      );

      txtOpt(
        o,
        'cloture',
        'AAAA-MM-JJ HH:mm, heure de Paris',
        true
      );

      if (kind !== 'quiz') {
        txtOpt(
          o,
          'reponses',
          'Réponses acceptées, séparées par | ; ex. titre|autre orthographe',
          true
        );

        o.addAttachmentOption(x =>
          x
            .setName('media')
            .setDescription(
              kind === 'blind'
                ? 'Fichier audio (MP3, WAV...)'
                : 'Photo de l’artiste ou du groupe'
            )
            .setRequired(true)
        );
      }

      txtOpt(
        o,
        'publication',
        'Facultatif : AAAA-MM-JJ HH:mm, sinon maintenant'
      );

      txtOpt(
        o,
        'texte',
        'Introduction personnalisée facultative'
      );

      if (kind === 'blind') {
        o.addNumberOption(x =>
          x
            .setName('depart')
            .setDescription(
              'Début de l’extrait dans le morceau, en secondes'
            )
            .setMinValue(0)
            .setMaxValue(36000)
        );
      }

      if (kind === 'quiz') {
        o.addAttachmentOption(x =>
          x
            .setName('questions')
            .setDescription(
              'Fichier JSON ; sinon questions-exemple.json'
            )
        );
      }

      txtOpt(
        o,
        'lien',
        'Lien de la source à afficher après révélation, facultatif'
      );

      return o;
    });
  }

  root.addSubcommand(o => {
    o
      .setName('modifier')
      .setDescription(
        'Modifier une animation grâce à son ID'
      );

    txtOpt(
      o,
      'id',
      'ID de l’animation',
      true
    );

    for (const [name, description] of [
      ['titre', 'Nouveau titre'],
      [
        'texte',
        'Nouveau texte ; écrire - pour remettre le texte par défaut',
      ],
      [
        'publication',
        'Nouvelle date avant publication, AAAA-MM-JJ HH:mm',
      ],
      [
        'cloture',
        'Nouvelle clôture, AAAA-MM-JJ HH:mm',
      ],
      [
        'reponses',
        'Nouvelles réponses séparées par |',
      ],
      [
        'lien',
        'Lien source ; - pour enlever',
      ],
    ]) {
      txtOpt(
        o,
        name,
        description
      );
    }

    o.addChannelOption(x =>
      x
        .setName('salon')
        .setDescription(
          'Nouveau salon avant publication'
        )
        .addChannelTypes(0)
    );

    o.addAttachmentOption(x =>
      x
        .setName('media')
        .setDescription(
          'Remplacer l’audio ou la photo avant toute participation'
        )
    );

    o.addAttachmentOption(x =>
      x
        .setName('questions')
        .setDescription(
          'Remplacer le quiz JSON avant toute participation'
        )
    );

    o.addNumberOption(x =>
      x
        .setName('depart')
        .setDescription(
          'Début audio, avec un nouveau fichier media'
        )
        .setMinValue(0)
        .setMaxValue(36000)
    );

    return o;
  });

  for (const [name, description] of [
    [
      'fermer',
      'Fermer immédiatement les participations',
    ],
    [
      'supprimer',
      'Annuler une animation sans effacer les points',
    ],
    [
      'reveler',
      'Publier la solution après la clôture',
    ],
  ]) {
    root.addSubcommand(o => {
      o
        .setName(name)
        .setDescription(description);

      return txtOpt(
        o,
        'id',
        'ID de l’animation',
        true
      );
    });
  }

  root.addSubcommand(o =>
    o
      .setName('liste')
      .setDescription(
        'Lister les 20 dernières animations et leurs IDs'
      )
  );

  root.addSubcommand(o => {
    o
      .setName('installer')
      .setDescription(
        'Publier le menu du studio'
      );

    return o.addChannelOption(x =>
      x
        .setName('salon')
        .setDescription('Salon du menu')
        .addChannelTypes(0)
        .setRequired(true)
    );
  });

  root.addSubcommand(o => {
    o
      .setName('classement')
      .setDescription(
        'Consulter ou publier le classement commun'
      );

    o.addChannelOption(x =>
      x
        .setName('salon')
        .setDescription(
          'Facultatif : publier un message actualisé'
        )
        .addChannelTypes(0)
    );

    return txtOpt(
      o,
      'saison',
      'Facultatif : consulter une ancienne saison, sans publication'
    );
  });

  root.addSubcommand(o =>
    txtOpt(
      o
        .setName('export')
        .setDescription(
          'Exporter tous les scores en CSV'
        ),
      'saison',
      'Nom d’une ancienne saison, facultatif'
    )
  );

  root.addSubcommand(o => {
    o
      .setName('saison')
      .setDescription(
        'Choisir le classement de saison sans effacer l’historique'
      );

    txtOpt(
      o,
      'nom',
      'Nom exact : un nouveau nom crée un nouveau classement',
      true
    );

    o.addBooleanOption(x =>
      x
        .setName('confirmer')
        .setDescription(
          'Confirmer le changement de saison'
        )
        .setRequired(true)
    );

    return o;
  });

  root.addSubcommand(o =>
    o
      .setName('diagnostic')
      .setDescription(
        'Vérifier stockage, saison et programmation'
      )
  );

  addLootboxCommand(root);

  return [
    root.toJSON(),
  ];
}

// ============================================================
// MESSAGES PUBLICS ET CLASSEMENT
// ============================================================

function publicPayload(a) {
  const closed =
    a.status === 'closed' ||
    a.status === 'cancelled' ||
    Date.now() >= a.close;

  const e = emb()
    .setTitle(a.title)
    .setDescription(
      (a.text || config.text[a.kind]) +
      `\n\n⏰ Fin : <t:${unix(a.close)}:F>` +
      `\n🏆 Classement : **${safe(a.season)}**`
    )
    .setFooter({
      text:
        `${config.name} · ID ${a.id}`,
    });

  if (a.status === 'cancelled') {
    e.setDescription(
      'Cette animation a été annulée. ' +
      'Les points déjà attribués sont conservés.'
    );
  } else if (
    closed &&
    a.revealed
  ) {
    e.setDescription(
      a.kind === 'quiz'
        ? 'Quiz terminé. Merci pour vos participations !'
        : 'L’animation est terminée.\n\n' +
          `✅ **La réponse : ${safe(a.answers[0])}**`
    );

    if (a.link) {
      e.addFields({
        name: 'Pour aller plus loin',
        value:
          `[Découvrir la source](${a.link})`,
      });
    }
  } else if (closed) {
    e.setDescription(
      'Les participations sont fermées. La solution arrive.'
    );
  }

  const components = [
    row(
      btn(
        `play:${a.id}`,
        'Participer',
        ButtonStyle.Primary,
        a.kind === 'blind'
          ? '🎧'
          : a.kind === 'artist'
            ? '👀'
            : '🧠'
      ).setDisabled(closed),

      btn(
        'rank',
        'Classement',
        ButtonStyle.Secondary,
        '🏆'
      )
    ),
  ];

  return {
    content: '',
    embeds: [e],
    components,
    allowedMentions: {
      parse: [],
    },
  };
}

function rankPayload(
  store,
  user,
  season
) {
  season =
    season ||
    store.setting('season');

  const rows =
    store.ranking(season);

  const lines = rows
    .slice(0, 20)
    .map(x => {
      const position =
        x.rank < 4
          ? ['🥇', '🥈', '🥉'][x.rank - 1]
          : `**${x.rank}.**`;

      return (
        `${position} <@${x.user}> · ` +
        `**${x.points} pts**`
      );
    });

  const own = rows.find(
    x => x.user === user
  );

  if (
    own &&
    !rows
      .slice(0, 20)
      .some(x => x.user === user)
  ) {
    lines.push(
      `\n**${own.rank}.** <@${own.user}> · ` +
      `**${own.points} pts**`
    );
  }

  return {
    embeds: [
      emb()
        .setTitle(
          `🏆 ${season}`.slice(0, 256)
        )
        .setDescription(
          lines.join('\n\n') ||
          'Le classement attend ses premiers points !'
        )
        .setFooter({
          text:
            'Blind test · Quiz · Qui est-ce ? · ' +
            'Égalité de points = même rang',
        })
        .setTimestamp(),
    ],
    components: [],
    allowedMentions: {
      parse: [],
    },
  };
}

// ============================================================
// MESSAGES DE JEU ÉPHÉMÈRES
// ============================================================

async function gamePayload(a, s) {
  const e = emb()
    .setTitle(a.title);

  let components = [];
  let files = [];

  if (s.phase === 'finished') {
    e.setDescription(
      a.kind === 'quiz'
        ? '🏁 **Quiz terminé !**\n\n' +
          `Ton score : **${s.points} points**.\n` +
          'Les points de tes bonnes réponses sont enregistrés ' +
          'dans le classement commun.'
        : s.result === 'correct'
          ? `${config.text.correct}\n\n` +
            `**+${s.points} points**`
          : s.result === 'wrong'
            ? config.text.wrong
            : 'Cette participation est terminée, sans point. ' +
              'La solution sera publiée à la clôture.'
    );

    return {
      content: '',
      embeds: [e],
      components: [
        row(
          btn(
            'rank',
            'Classement',
            ButtonStyle.Secondary,
            '🏆'
          )
        ),
      ],
      attachments: [],
      allowedMentions: {
        parse: [],
      },
    };
  }

  if (a.kind === 'quiz') {
    const q =
      a.questions[s.index];

    if (s.phase === 'feedback') {
      const feedback =
        s.last.timeout
          ? '⏱️ Temps écoulé.'
          : s.last.correct
            ? '✅ Bonne réponse !'
            : '❌ Ce n’est pas la bonne réponse.';

      e.setDescription(
        `${feedback}\n\n` +
        `**${safe(q.choices[q.answer])}**\n` +
        `${q.explanation ? safe(q.explanation) : ''}` +
        `\n\n**+${s.last.points} points** · ` +
        `Total : **${s.points}**`
      );

      components = [
        row(
          btn(
            `next:${a.id}:${s.index}`,
            s.index === a.questions.length - 1
              ? 'Voir mon bilan'
              : 'Question suivante',
            ButtonStyle.Primary,
            '➡️'
          )
        ),
      ];
    } else {
      e.setDescription(
        `**Question ${s.index + 1}/${a.questions.length}**` +
        `\n\n${safe(q.question)}` +
        `\n\n⏱️ ${a.rules.seconds} secondes · ` +
        `<t:${unix(s.deadline)}:R>` +
        `\n🎯 De ${a.rules.minPoints} à ` +
        `${a.rules.maxPoints} points pour une bonne réponse.`
      );

      components = [
        row(
          ...q.choices.map((c, i) =>
            btn(
              `choice:${a.id}:${s.index}:${i}`,
              c,
              ButtonStyle.Primary
            )
          )
        ),
      ];
    }
  } else {
    const stage = s.stage;
    const timeout =
      s.phase === 'timeout';

    const info =
      a.kind === 'blind'
        ? `🎧 **Extrait de ${a.rules.durations[stage]} secondes**`
        : `👀 **Flou : ${a.rules.blur[stage]} %**`;

    e.setDescription(
      `${info}\n\n` +
      `🎯 **${a.rules.points[stage]} points** ` +
      'si tu trouves à ce palier.\n\n' +
      (
        timeout
          ? config.text.timeout
          : 'Une seule réponse, fais ton choix.\n' +
            `⏱️ Réponds avant <t:${unix(s.deadline)}:T>.`
      )
    );

    const file =
      a.files[stage];

    const name =
      a.kind === 'blind'
        ? `extrait-${a.rules.durations[stage]}s.mp3`
        : 'portrait.png';

    files = [
      new AttachmentBuilder(
        await fs.readFile(file),
        { name }
      ),
    ];

    if (a.kind === 'artist') {
      e.setImage(
        `attachment://${name}`
      );
    }

    components = [
      row(
        btn(
          `respond:${a.id}:${stage}`,
          'Répondre',
          ButtonStyle.Primary,
          '✍️'
        ).setDisabled(timeout),

        btn(
          `stage:${a.id}:${stage}`,
          stage === 2
            ? 'Passer et terminer'
            : a.kind === 'blind'
              ? 'Plus d’extrait'
              : 'Déflouter',
          ButtonStyle.Secondary,
          stage === 2
            ? '⏭️'
            : '➡️'
        )
      ),
    ];
  }

  return {
    content: '',
    embeds: [e],
    components,
    files,
    attachments: [],
    allowedMentions: {
      parse: [],
    },
  };
}

// ============================================================
// DÉMARRAGE
// ============================================================

async function main() {
  for (const key of [
    'DISCORD_TOKEN',
    'DISCORD_CLIENT_ID',
    'DISCORD_GUILD_ID',
  ]) {
    if (!process.env[key]) {
      throw new Error(
        `Variable manquante : ${key}`
      );
    }
  }

  const dir =
    process.env.DATA_DIR ||
    path.join(__dirname, 'data');

  if (
    process.env.RAILWAY_ENVIRONMENT_ID &&
    (
      !process.env.DATA_DIR ||
      !process.env.RAILWAY_VOLUME_MOUNT_PATH
    )
  ) {
    throw new Error(
      'Attache un volume /data au service Railway ' +
      'et ajoute DATA_DIR=/data.'
    );
  }

  if (
    process.env.RAILWAY_VOLUME_MOUNT_PATH &&
    path.resolve(dir) !==
      path.resolve(
        process.env.RAILWAY_VOLUME_MOUNT_PATH
      )
  ) {
    throw new Error(
      'DATA_DIR doit correspondre au Mount Path du volume.'
    );
  }

  const store =
    new Store(dir);

  const engine =
    new Engine(store);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
    ],
    allowedMentions: {
      parse: [],
    },
  });

  const lootEnabled =
    process.env.ENABLE_LOOTBOX === 'true';

  const locks = new Map();
  const timers = new Map();

  let dirty = 1;
  let working = false;
  let stopping = false;

  const lootbox = createLootbox({
    store,
    engine,
    dir,
    enabled: lootEnabled,
    download,

    onAward: () => {
      dirty++;
    },
  });

  const queue = (key, fn) => {
    const p = (
      locks.get(key) ||
      Promise.resolve()
    )
      .catch(() => {})
      .then(fn);

    locks.set(key, p);

    p.finally(() => {
      if (locks.get(key) === p) {
        locks.delete(key);
      }
    }).catch(() => {});

    return p;
  };

  const staff = i =>
    i.memberPermissions?.has(
      PermissionFlagsBits.ManageGuild
    ) ||
    (
      process.env.ADMIN_ROLE_ID &&
      (
        i.member?.roles?.cache?.has(
          process.env.ADMIN_ROLE_ID
        ) ||
        (
          Array.isArray(i.member?.roles) &&
          i.member.roles.includes(
            process.env.ADMIN_ROLE_ID
          )
        )
      )
    );

  // ----------------------------------------------------------
  // MISE À JOUR D’UN MESSAGE PUBLIC
  // ----------------------------------------------------------

  const update = async aid => {
    const a =
      store.activity(aid);

    if (!a.message) {
      return;
    }

    const ch =
      await client.channels.fetch(
        a.channel
      );

    const payload =
      publicPayload(a);

    payload.attachments = [];

    if (
      a.kind === 'artist' &&
      a.revealed &&
      a.original
    ) {
      payload.files = [
        new AttachmentBuilder(
          await fs.readFile(a.original),
          {
            name: 'solution.png',
          }
        ),
      ];

      payload.embeds[0].setImage(
        'attachment://solution.png'
      );
    } else {
      const name = 'studio.png';

      payload.files = [
        new AttachmentBuilder(
          await banner(
            a.title,
            kindName[a.kind]
          ),
          { name }
        ),
      ];

      payload.embeds[0].setImage(
        `attachment://${name}`
      );
    }

    await ch.messages.edit(
      a.message,
      payload
    );
  };

  // ----------------------------------------------------------
  // INFORMATIONS STAFF
  // ----------------------------------------------------------

  const note = async (a, event) => {
    if (!process.env.STAFF_CHANNEL_ID) {
      return;
    }

    try {
      const ch =
        await client.channels.fetch(
          process.env.STAFF_CHANNEL_ID
        );

      await ch.send({
        embeds: [
          emb()
            .setTitle(event)
            .setDescription(
              `**${safe(a.title)}**\n` +
              `ID : \`${a.id}\`\n` +
              `Type : ${kindName[a.kind]}\n` +
              `Salon : <#${a.channel}>\n` +
              `Publication : <t:${unix(a.open)}:F>\n` +
              `Clôture : <t:${unix(a.close)}:F>\n` +
              `Saison : ${safe(a.season)}`
            ),
        ],
        allowedMentions: {
          parse: [],
        },
      });
    } catch (e) {
      console.error(
        'Notification staff :',
        e.code || e.name
      );
    }
  };

  // ----------------------------------------------------------
  // PUBLICATION PROGRAMMÉE
  // ----------------------------------------------------------

  const publish = async a => {
    const channel =
      await client.channels.fetch(
        a.channel
      );

    if (a.status === 'publishing') {
      const recent =
        await channel.messages.fetch({
          limit: 50,
        });

      const found = recent.find(
        m =>
          m.author.id === client.user.id &&
          m.embeds.some(e =>
            e.footer?.text?.endsWith(
              `ID ${a.id}`
            )
          )
      );

      if (found) {
        a.message = found.id;
        a.status = 'published';
        a.error = null;

        store.save(a);
        return;
      }
    }

    a.status = 'publishing';
    store.save(a);

    const payload =
      publicPayload(a);

    payload.files = [
      new AttachmentBuilder(
        await banner(
          a.title,
          kindName[a.kind]
        ),
        {
          name: 'studio.png',
        }
      ),
    ];

    payload.embeds[0].setImage(
      'attachment://studio.png'
    );

    const message =
      await channel.send({
        ...payload,
        nonce: a.id,
        enforceNonce: true,
      });

    a.message = message.id;
    a.status = 'published';
    a.error = null;

    store.save(a);

    await note(
      a,
      'Animation publiée'
    );
  };

  // ----------------------------------------------------------
  // PROGRAMMATION ET ACTUALISATION DU CLASSEMENT
  // ----------------------------------------------------------

  const tick = async () => {
    if (
      working ||
      stopping ||
      !client.isReady()
    ) {
      return;
    }

    working = true;

    try {
      for (const original of store.all()) {
        await queue(
          `admin:${original.id}`,
          async () => {
            const a =
              store.activity(original.id);

            if (
              [
                'scheduled',
                'publishing',
              ].includes(a.status) &&
              Date.now() >= a.close
            ) {
              a.status = 'closed';

              a.error =
                'La date de clôture est passée avant publication.';

              store.save(a);
              return;
            }

            if (
              [
                'scheduled',
                'publishing',
              ].includes(a.status) &&
              Date.now() >= a.open
            ) {
              try {
                await publish(a);
              } catch (e) {
                a.error =
                  `Publication impossible (${e.code || e.name}). ` +
                  'Vérifie les permissions et le salon.';

                store.save(a);

                console.error(
                  'Publication :',
                  a.id,
                  e.code || e.name
                );
              }

              return;
            }

            if (
              a.status === 'published' &&
              Date.now() >= a.close
            ) {
              a.status = 'closed';
              a.revealed = true;

              store.save(a);

              try {
                await update(a.id);
              } catch (e) {
                console.error(
                  'Clôture :',
                  a.id,
                  e.code || e.name
                );
              }
            }
          }
        );
      }

      if (dirty) {
        const version = dirty;

        for (
          const b of
          store.setting('boards') || []
        ) {
          try {
            const ch =
              await client.channels.fetch(
                b.channel
              );

            await ch.messages.edit(
              b.message,
              rankPayload(store)
            );
          } catch (e) {
            console.error(
              'Classement :',
              e.code || e.name
            );
          }
        }

        if (dirty === version) {
          dirty = 0;
        }
      }
    } finally {
      working = false;
    }
  };

  // ----------------------------------------------------------
  // AFFICHAGE ET CHRONOMÈTRE DES PARTICIPATIONS
  // ----------------------------------------------------------

  const render = async (i, a, s) => {
    if (
      a.kind !== 'quiz' &&
      s.phase === 'timeout' &&
      s.stage < 2
    ) {
      s = engine.stage(
        a.id,
        s.user,
        s.stage
      );
    }

    const key =
      `${a.id}:${s.user}`;

    if (timers.has(key)) {
      clearTimeout(
        timers.get(key)
      );

      timers.delete(key);
    }

    await i.editReply(
      await gamePayload(a, s)
    );

    if (s.phase === 'playing') {
      const index =
        a.kind === 'quiz'
          ? s.index
          : s.stage;

      const timer = setTimeout(
        () =>
          queue(key, async () => {
            const current =
              store.session(
                a.id,
                s.user
              );

            if (
              !current ||
              current.phase !== 'playing' ||
              (
                a.kind === 'quiz'
                  ? current.index
                  : current.stage
              ) !== index
            ) {
              return;
            }

            const fresh =
              engine.get(
                a.id,
                s.user
              );

            if (
              fresh.phase !== 'playing'
            ) {
              try {
                await render(
                  i,
                  store.activity(a.id),
                  fresh
                );
              } catch {}
            }
          }).catch(() => {}),
        Math.max(
          1,
          s.deadline - Date.now() + 30
        )
      );

      timer.unref();
      timers.set(key, timer);
    }
  };

  const questions = async attachment =>
    validateQuestions(
      attachment
        ? JSON.parse(
            (
              await download(
                attachment.url,
                200000
              )
            ).toString('utf8')
          )
        : JSON.parse(
            await fs.readFile(
              path.join(
                __dirname,
                'questions-exemple.json'
              ),
              'utf8'
            )
          )
    );

  const parseAnswers = s =>
    s
      .split('|')
      .map(x => x.trim())
      .filter(Boolean)
      .slice(0, 30);

  // ----------------------------------------------------------
  // TRAITEMENT DES COMMANDES STAFF
  // ----------------------------------------------------------

  async function command(i) {
    if (!staff(i)) {
      throw new Error(
        'Cette commande est réservée au staff.'
      );
    }

    await i.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    const sub =
      i.options.getSubcommand();

    const str = n =>
      i.options.getString(n);

    const att = n =>
      i.options.getAttachment(n);

    if (sub === 'lootbox') {
      return queue(
        'lootbox-config',
        () => lootbox.configure(i)
      );
    }

    if (
      [
        'blind',
        'portrait',
        'quiz',
      ].includes(sub)
    ) {
      const kind =
        sub === 'portrait'
          ? 'artist'
          : sub;

      const aid = id();

      const open =
        str('publication')
          ? parisDate(str('publication'))
          : Date.now();

      const close =
        parisDate(str('cloture'));

      if (
        close <= open ||
        close <= Date.now()
      ) {
        throw new Error(
          'La clôture doit être après la publication ' +
          'et dans le futur.'
        );
      }

      const link = str('lien');

      if (
        link &&
        !/^https:\/\/\S+$/.test(link)
      ) {
        throw new Error(
          'Le lien source doit commencer par https://.'
        );
      }

      const media =
        kind === 'quiz'
          ? {
              questions: await questions(
                att('questions')
              ),
            }
          : await prepare(
              kind,
              aid,
              att('media'),
              i.options.getNumber('depart') || 0,
              dir
            );

      const a = engine.create({
        id: aid,
        title: str('titre'),
        kind,
        channel:
          i.options.getChannel('salon').id,
        open,
        close,
        text: str('texte') || '',

        answers:
          kind === 'quiz'
            ? []
            : parseAnswers(str('reponses')),

        link: link || null,

        ...media,
      });

      await note(
        a,
        'Animation créée'
      );

      await tick();

      const fresh =
        store.activity(a.id);

      return i.editReply({
        embeds: [
          emb()
            .setTitle(
              'Animation enregistrée'
            )
            .setDescription(
              `**${safe(a.title)}**\n\n` +
              `ID : \`${a.id}\`\n` +
              `Publication : <t:${unix(a.open)}:F>\n` +
              `Clôture : <t:${unix(a.close)}:F>\n` +
              `État : ${fresh.status}\n` +
              `${fresh.error || ''}`
            ),
        ],
      });
    }

    if (sub === 'installer') {
      const ch =
        i.options.getChannel('salon');

      const file = 'studio.png';

      const buttons = [
        btn(
          'live',
          'Les jeux ouverts',
          ButtonStyle.Primary,
          '🎮'
        ),

        btn(
          'rank',
          'Classement',
          ButtonStyle.Secondary,
          '🏆'
        ),

        btn(
          'stats',
          'Mes points',
          ButtonStyle.Secondary,
          '📊'
        ),
      ];

      if (lootEnabled) {
        buttons.push(
          btn(
            'loot',
            'Mon coffre du jour',
            ButtonStyle.Secondary,
            '🎁'
          )
        );
      }

      await ch.send({
        embeds: [
          emb()
            .setTitle(
              'Bienvenue au studio 🎶'
            )
            .setDescription(
              config.text.home
            )
            .setImage(
              `attachment://${file}`
            ),
        ],

        files: [
          new AttachmentBuilder(
            await banner(
              'Bienvenue au studio',
              'Blind test · Quiz · Qui est-ce ?'
            ),
            {
              name: file,
            }
          ),
        ],

        components: [
          row(...buttons),
        ],

        allowedMentions: {
          parse: [],
        },
      });

      return i.editReply(
        `Menu installé dans <#${ch.id}>.`
      );
    }

    if (sub === 'classement') {
      const ch =
        i.options.getChannel('salon');

      if (!ch) {
        return i.editReply(
          rankPayload(
            store,
            null,
            str('saison') || undefined
          )
        );
      }

      if (str('saison')) {
        throw new Error(
          'Pour publier un classement actualisé, ' +
          'ne renseigne pas saison.'
        );
      }

      const msg =
        await ch.send(
          rankPayload(store)
        );

      const boards =
        store.setting('boards') || [];

      boards.push({
        channel: ch.id,
        message: msg.id,
      });

      store.setting(
        'boards',
        boards
      );

      return i.editReply(
        'Classement publié : le même message se mettra à jour, ' +
        'sans nouvelle annonce.'
      );
    }

    if (sub === 'export') {
      const season =
        str('saison') ||
        store.setting('season');

      const cell = v =>
        `"${String(v)
          .replace(/^[=+\-@]/, "'$&")
          .replace(/"/g, '""')}"`;

      const csv =
        '\uFEFF' +
        [
          [
            'rang',
            'discord_id',
            'pseudo',
            'points',
          ],

          ...store
            .ranking(season)
            .map(x => [
              x.rank,
              x.user,
              x.name,
              x.points,
            ]),
        ]
          .map(r =>
            r.map(cell).join(';')
          )
          .join('\r\n');

      return i.editReply({
        content:
          `Tous les scores : ${safe(season)}`,

        files: [
          new AttachmentBuilder(
            Buffer.from(csv),
            {
              name: 'classement-sacem.csv',
            }
          ),
        ],
      });
    }

    if (sub === 'saison') {
      if (
        !i.options.getBoolean('confirmer')
      ) {
        return i.editReply(
          'Aucun changement.'
        );
      }

      const active =
        store.all().filter(
          a =>
            [
              'published',
              'scheduled',
              'publishing',
            ].includes(a.status) &&
            a.close > Date.now()
        );

      if (active.length) {
        throw new Error(
          'Ferme ou annule les animations encore ouvertes ' +
          'ou programmées avant de changer de saison.'
        );
      }

      const name =
        str('nom').trim();

      if (
        !name ||
        name.length > 100
      ) {
        throw new Error(
          'Choisis un nom de saison de 1 à 100 caractères.'
        );
      }

      store.setting(
        'season',
        name
      );

      dirty++;

      return i.editReply(
        `Classement sélectionné : **${safe(name)}**. ` +
        'L’historique des autres saisons reste conservé. ' +
        'Un nom déjà utilisé reprend son classement.'
      );
    }

    if (sub === 'liste') {
      const items =
        store.all()
          .sort(
            (a, b) =>
              b.created - a.created
          )
          .slice(0, 20);

      const description =
        items.map(a =>
          `**${safe(a.title)}**\n` +
          `\`${a.id}\` · ${a.status} · <#${a.channel}>\n` +
          `<t:${unix(a.open)}:f> → <t:${unix(a.close)}:f>` +
          (
            a.error
              ? `\n⚠️ ${a.error}`
              : ''
          )
        ).join('\n\n');

      return i.editReply({
        embeds: [
          emb()
            .setTitle(
              'Les dernières animations'
            )
            .setDescription(
              description.slice(0, 4000) ||
              'Aucune animation.'
            ),
        ],
      });
    }

    if (sub === 'diagnostic') {
      return i.editReply({
        embeds: [
          emb()
            .setTitle('Diagnostic')
            .setDescription(
              `Saison : **${safe(store.setting('season'))}**\n` +
              `Stockage : \`${safe(path.join(dir, 'sacem.sqlite'))}\`\n` +
              `Animations : ${store.all().length}\n` +
              `Lootbox : ${lootEnabled ? 'activée' : 'désactivée'}\n` +
              'Images : sharp\n' +
              'Audio : FFmpeg fourni par le Dockerfile\n\n' +
              'Le diagnostic indique la configuration ; ' +
              'teste un vrai fichier audio avant le lancement.'
            ),
        ],
      });
    }

    return queue(
      `admin:${str('id')}`,
      async () => {
        let a =
          store.activity(
            str('id')
          );

        if (sub === 'modifier') {
          if (
            [
              'closed',
              'cancelled',
            ].includes(a.status) ||
            Date.now() >= a.close
          ) {
            throw new Error(
              'Animation terminée : crée une nouvelle édition.'
            );
          }

          const contentChanged =
            str('reponses') !== null ||
            att('media') ||
            att('questions');

          if (
            contentChanged &&
            store.count(a.id)
          ) {
            throw new Error(
              'Il y a déjà des participations : les solutions ' +
              'et les médias ne peuvent plus être changés. ' +
              'Le titre, le texte et la clôture restent modifiables.'
            );
          }

          if (
            i.options.getChannel('salon')
          ) {
            if (a.message) {
              throw new Error(
                'Le salon ne peut être changé qu’avant publication.'
              );
            }

            a.channel =
              i.options.getChannel('salon').id;
          }

          if (str('publication')) {
            if (a.message) {
              throw new Error(
                'L’animation est déjà publiée.'
              );
            }

            a.open =
              parisDate(
                str('publication')
              );
          }

          if (str('cloture')) {
            a.close =
              parisDate(
                str('cloture')
              );
          }

          if (
            a.close <= a.open ||
            a.close <= Date.now()
          ) {
            throw new Error(
              'Dates invalides.'
            );
          }

          if (str('titre')) {
            if (
              str('titre').length > 150
            ) {
              throw new Error(
                'Titre limité à 150 caractères.'
              );
            }

            a.title =
              str('titre');
          }

          if (
            str('texte') !== null
          ) {
            a.text =
              str('texte') === '-'
                ? ''
                : str('texte');
          }

          if (
            str('lien') !== null
          ) {
            if (
              str('lien') !== '-' &&
              !/^https:\/\/\S+$/.test(
                str('lien')
              )
            ) {
              throw new Error(
                'Lien HTTPS attendu.'
              );
            }

            a.link =
              str('lien') === '-'
                ? null
                : str('lien');
          }

          if (
            str('reponses') !== null
          ) {
            if (a.kind === 'quiz') {
              throw new Error(
                'Pour le quiz, utilise le fichier questions.'
              );
            }

            a.answers =
              parseAnswers(
                str('reponses')
              );

            if (!a.answers.length) {
              throw new Error(
                'Au moins une réponse attendue.'
              );
            }
          }

          if (
            att('questions')
          ) {
            if (a.kind !== 'quiz') {
              throw new Error(
                'Cette option est réservée aux quiz.'
              );
            }

            a.questions =
              await questions(
                att('questions')
              );
          }

          if (att('media')) {
            if (a.kind === 'quiz') {
              throw new Error(
                'Un quiz utilise un fichier questions.'
              );
            }

            const prepared =
              await prepare(
                a.kind,
                id(),
                att('media'),
                i.options.getNumber('depart') || 0,
                dir
              );

            Object.assign(
              a,
              prepared
            );

            a.rules =
              structuredClone(
                config[a.kind]
              );
          } else if (
            i.options.getNumber('depart') !== null
          ) {
            throw new Error(
              'Pour changer le départ audio, ' +
              'joins de nouveau le fichier media.'
            );
          }

          store.save(a);

          if (a.message) {
            await update(a.id);
          }

          await note(
            a,
            'Animation modifiée'
          );

          return i.editReply(
            `Animation modifiée : \`${a.id}\`.`
          );
        }

        if (sub === 'fermer') {
          a.close = Date.now();
          a.status = 'closed';
          a.revealed = true;

          store.save(a);

          if (a.message) {
            await update(a.id);
          }

          return i.editReply(
            'Participations fermées et solution publiée ' +
            'sur le message existant.'
          );
        }

        if (sub === 'supprimer') {
          a.status = 'cancelled';

          store.save(a);

          if (a.message) {
            await update(a.id);
          }

          return i.editReply(
            'Animation annulée. ' +
            'Aucun point ni historique effacé.'
          );
        }

        if (sub === 'reveler') {
          if (
            Date.now() < a.close &&
            a.status !== 'closed'
          ) {
            throw new Error(
              'Ferme les participations avant de révéler la réponse.'
            );
          }

          a.revealed = true;

          store.save(a);

          if (a.message) {
            await update(a.id);
          }

          return i.editReply(
            'Solution affichée sur le message de l’animation.'
          );
        }
      }
    );
  }

  // ----------------------------------------------------------
  // BOUTONS ET FORMULAIRES DES MEMBRES
  // ----------------------------------------------------------

  async function component(i) {
    const [
      action,
      aid,
      step,
      choice,
    ] = i.customId.split(':');

    if (action === 'respond') {
      const a =
        store.activity(aid);

      engine.open(a);

      const s =
        engine.get(
          aid,
          i.user.id
        );

      if (
        s.phase !== 'playing' ||
        s.stage !== +step
      ) {
        throw new Error(
          'Ce palier est terminé. ' +
          'Reprends depuis le message de l’animation.'
        );
      }

      const modal =
        new ModalBuilder()
          .setCustomId(
            `answer:${aid}:${step}`
          )
          .setTitle('Ta réponse');

      modal.addComponents(
        row(
          new TextInputBuilder()
            .setCustomId('answer')
            .setLabel(
              a.kind === 'blind'
                ? 'Quel est le titre du morceau ?'
                : 'Quel est cet artiste ou ce groupe ?'
            )
            .setStyle(
              TextInputStyle.Short
            )
            .setMaxLength(200)
            .setRequired(true)
        )
      );

      return i.showModal(modal);
    }

    if (action === 'answer') {
      await i.deferReply({
        flags:
          MessageFlags.Ephemeral,
      });
    } else if (
      [
        'play',
        'rank',
        'live',
        'stats',
        'loot',
      ].includes(action)
    ) {
      await i.deferReply({
        flags:
          MessageFlags.Ephemeral,
      });
    } else {
      await i.deferUpdate();
    }

    const user =
      i.user.id;

    const name =
      i.member?.displayName ||
      i.user.globalName ||
      i.user.username;

    if (action === 'rank') {
      return i.editReply(
        rankPayload(
          store,
          user
        )
      );
    }

    if (action === 'stats') {
      const season =
        store.setting('season');

      const own =
        store.ranking(season)
          .find(
            x => x.user === user
          );

      const detail =
        store.db.prepare(`
          SELECT kind,sum(points) points
          FROM ledger
          WHERE user=? AND season=?
          GROUP BY kind
        `).all(
          user,
          season
        );

      return i.editReply({
        embeds: [
          emb()
            .setTitle(
              '📊 Mes points'
            )
            .setDescription(
              `**${safe(season)}**\n\n` +
              `Total : **${own?.points || 0} points**\n` +
              'Place : ' +
              (
                own
                  ? `**#${own.rank}**`
                  : 'pas encore classé'
              ) +
              '\n\n' +
              detail.map(x =>
                `${kindName[x.kind] || '🎁 Lootbox'} : ` +
                `${x.points} pts`
              ).join('\n')
            ),
        ],
      });
    }

    if (action === 'loot') {
      return lootbox.open(
        i,
        user,
        name
      );
    }

    if (action === 'live') {
      const items =
        store.all()
          .filter(
            a =>
              a.status === 'published' &&
              a.open <= Date.now() &&
              a.close > Date.now() &&
              a.message
          )
          .slice(-20);

      return i.editReply({
        embeds: [
          emb()
            .setTitle(
              '🎮 Les jeux ouverts'
            )
            .setDescription(
              items.map(a =>
                `${kindName[a.kind]} · ` +
                `[${safe(a.title)}]` +
                `(https://discord.com/channels/` +
                `${process.env.DISCORD_GUILD_ID}/` +
                `${a.channel}/${a.message})\n` +
                `Fin <t:${unix(a.close)}:R>`
              ).join('\n\n') ||
              'Aucune animation ouverte pour le moment.'
            ),
        ],
      });
    }

    return queue(
      `${aid}:${user}`,
      async () => {
        const a =
          store.activity(aid);

        let s;

        if (action === 'play') {
          s = engine.start(
            aid,
            user,
            name
          );
        } else if (action === 'stage') {
          s = engine.stage(
            aid,
            user,
            +step
          );
        } else if (action === 'answer') {
          s = engine.answer(
            aid,
            user,
            +step,
            i.fields.getTextInputValue(
              'answer'
            )
          );
        } else if (action === 'choice') {
          s = engine.quizAnswer(
            aid,
            user,
            +step,
            +choice
          );
        } else if (action === 'next') {
          s = engine.quizNext(
            aid,
            user,
            +step
          );
        } else {
          throw new Error(
            'Action inconnue.'
          );
        }

        dirty++;

        return render(
          i,
          a,
          s
        );
      }
    );
  }

  // ----------------------------------------------------------
  // ÉVÉNEMENTS DISCORD
  // ----------------------------------------------------------

  client.on(
    Events.InteractionCreate,
    async i => {
      if (
        i.guildId !==
          process.env.DISCORD_GUILD_ID ||
        (
          !i.isChatInputCommand() &&
          !i.isButton() &&
          !i.isModalSubmit()
        )
      ) {
        return;
      }

      try {
        if (i.isChatInputCommand()) {
          await command(i);
        } else {
          await component(i);
        }
      } catch (e) {
        console.error(
          'Action :',
          e.code || e.name
        );

        const content =
          String(
            e.message ||
            'Une erreur est survenue. ' +
            'Reprends depuis le message public.'
          )
            .replace(
              /https:\/\/\S+/g,
              '[lien]'
            )
            .slice(0, 1500);

        try {
          if (
            i.deferred ||
            i.replied
          ) {
            await i.followUp({
              content,
              flags:
                MessageFlags.Ephemeral,
            });
          } else {
            await i.reply({
              content,
              flags:
                MessageFlags.Ephemeral,
            });
          }
        } catch {}
      }
    }
  );

  client.once(
    Events.ClientReady,
    () => {
      console.log(
        `Connecté : ${client.user.tag}. ` +
        'Classement commun et stockage actifs.'
      );

      tick().catch(e =>
        console.error(
          'Reprise :',
          e.code || e.name
        )
      );
    }
  );

  client.on(
    Events.Error,
    e =>
      console.error(
        'Discord :',
        e.code || e.name
      )
  );

  const interval = setInterval(
    () =>
      tick().catch(e =>
        console.error(
          'Programmation :',
          e.code || e.name
        )
      ),
    15000
  );

  interval.unref();

  await new REST({
    version: '10',
  })
    .setToken(
      process.env.DISCORD_TOKEN
    )
    .put(
      Routes.applicationGuildCommands(
        process.env.DISCORD_CLIENT_ID,
        process.env.DISCORD_GUILD_ID
      ),
      {
        body: commands(),
      }
    );

  await client.login(
    process.env.DISCORD_TOKEN
  );

  // ----------------------------------------------------------
  // ARRÊT PROPRE
  // ----------------------------------------------------------

  const shutdown = async () => {
    stopping = true;

    clearInterval(interval);

    for (const t of timers.values()) {
      clearTimeout(t);
    }

    client.destroy();

    await Promise.allSettled(
      [...locks.values()]
    );

    store.db.close();

    process.removeListener(
      'SIGTERM',
      stop
    );

    process.removeListener(
      'SIGINT',
      stop
    );
  };

  const stop = () =>
    shutdown()
      .then(() =>
        process.exit(0)
      )
      .catch(() =>
        process.exit(1)
      );

  process.once(
    'SIGTERM',
    stop
  );

  process.once(
    'SIGINT',
    stop
  );

  return {
    store,
    engine,
    client,
    command,
    component,
    tick,
    shutdown,
  };
}

if (require.main === module) {
  main().catch(e => {
    console.error(
      'Démarrage :',
      e.message
    );

    process.exit(1);
  });
}

module.exports = {
  main,
  commands,
  publicPayload,
  gamePayload,
  rankPayload,
};
