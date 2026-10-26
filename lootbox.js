'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, randomInt } = require('node:crypto');
const sharp = require('sharp');

const {
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  LabelBuilder,
  FileUploadBuilder,
  ChannelType,
} = require('discord.js');

const DEFAULT_TIERS = [
  {
    name: 'Commun',
    chance: 60,
    amount: 1,
    color: '#95A5A6',
    icon: '🎵',
    description: 'Un premier coup de pouce pour ton classement.',
  },
  {
    name: 'Peu commun',
    chance: 25,
    amount: 2,
    color: '#2ECC71',
    icon: '🎶',
    description: 'Un petit bonus pour continuer sur ta lancée.',
  },
  {
    name: 'Rare',
    chance: 10,
    amount: 3,
    color: '#3498DB',
    icon: '💿',
    description: 'Une belle trouvaille dans ton coffre du jour !',
  },
  {
    name: 'Épique',
    chance: 4,
    amount: 5,
    color: '#9B59B6',
    icon: '🎤',
    description: 'Ce coffre fait monter le volume… et ton score !',
  },
  {
    name: 'Légendaire',
    chance: 1,
    amount: 10,
    color: '#F1C40F',
    icon: '🏆',
    description:
      'Le coffre le plus rare et le plus gros bonus de points !',
  },
];

const STYLE = {
  title: '🎁 TON COFFRE DU JOUR',
  text:
    'Ton coffre est prêt. Quel sera celui du jour ?\n\n' +
    'Plus il est rare, plus tu gagnes de points pour le classement SACEM.',
  color: '#7046D3',
  seconds: 3,
  button: 'Ouvrir mon coffre',
};

const noPing = { parse: [] };

const row = (...items) =>
  new ActionRowBuilder().addComponents(items);

const button = (
  id,
  label,
  style = ButtonStyle.Secondary
) =>
  new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(style);

const dayParis = now =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

const requireValue = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const validColor = color => {
  requireValue(
    /^#[a-f0-9]{6}$/i.test(color),
    'Couleur attendue : #7046D3, par exemple.'
  );

  return color;
};

function validTiers(tiers) {
  requireValue(
    tiers.length === 5 &&
      tiers.every(
        (t, n) =>
          Number.isInteger(t.chance) &&
          t.chance >= 0 &&
          t.chance <= 100 &&
          Number.isInteger(t.amount) &&
          t.amount >= 1 &&
          t.amount <= 1000000 &&
          (!n || t.amount > tiers[n - 1].amount)
      ),
    'Les gains doivent être des entiers positifs ' +
      'et augmenter avec chaque rareté.'
  );

  requireValue(
    tiers.reduce((n, t) => n + t.chance, 0) === 100,
    'Le total des chances doit faire exactement 100 %. ' +
      'Corrige-le dans « Chances et gains ».'
  );

  return tiers;
}

function addLootboxCommand(root) {
  root.addSubcommand(o =>
    o
      .setName('lootbox')
      .setDescription(
        'Configurer les cinq coffres, leurs images, le GIF et les gains'
      )
  );
}

function textField(
  id,
  label,
  value,
  max = 100,
  paragraph = false,
  required = true
) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setStyle(
      paragraph
        ? TextInputStyle.Paragraph
        : TextInputStyle.Short
    )
    .setRequired(required)
    .setMaxLength(max);

  if (value) {
    input.setValue(String(value));
  }

  return new LabelBuilder()
    .setLabel(label)
    .setTextInputComponent(input);
}

function upload(id, label, required) {
  return new LabelBuilder()
    .setLabel(label)
    .setFileUploadComponent(
      new FileUploadBuilder()
        .setCustomId(id)
        .setRequired(required)
        .setMinValues(required ? 1 : 0)
        .setMaxValues(1)
    );
}

const uploaded = (i, id) =>
  [...(i.fields.getUploadedFiles(id)?.values() || [])][0] ||
  null;

const modal = (id, title, ...fields) =>
  new ModalBuilder()
    .setCustomId(id)
    .setTitle(title)
    .addComponents(fields);

function createLootbox({
  store,
  dir,
  enabled,
  download,
  onAward,
  wait = ms =>
    new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(),
}) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS sacem_loot_claims (
      claim TEXT PRIMARY KEY,
      json TEXT NOT NULL
    )
  `);

  let adminQueue = Promise.resolve();

  const serial = fn => {
    const p = adminQueue
      .catch(() => {})
      .then(fn);

    adminQueue = p;
    return p;
  };

  const get = () => ({
    ...STYLE,
    ...(store.setting('lootbox-ui') || {}),
    ...(store.setting('lootbox-style-v2') || {}),
  });

  const tiersFor = () =>
    (
      store.setting('lootbox-tiers-v2') ||
      DEFAULT_TIERS
    ).map((t, slot) => ({
      ...DEFAULT_TIERS[slot],
      ...t,
      slot,
    }));

  const ensureEnabled = () =>
    requireValue(
      enabled,
      'Mets ENABLE_LOOTBOX=true dans Railway, puis redéploie.'
    );

  const records = () => {
    const saved = store.setting('lootbox-messages-v2');

    if (saved) {
      return saved;
    }

    const old = store.setting('lootbox-ui');

    return old?.channel && old?.message
      ? [
          {
            channel: old.channel,
            message: old.message,
          },
        ]
      : [];
  };

  async function withImage(
    embed,
    file,
    components = []
  ) {
    const payload = {
      content: '',
      embeds: [embed],
      components,
      files: [],
      attachments: [],
      allowedMentions: noPing,
    };

    if (file) {
      const name =
        'coffre' + path.extname(file);

      payload.files = [
        new AttachmentBuilder(
          await fs.readFile(file),
          { name }
        ),
      ];

      embed.setImage(
        'attachment://' + name
      );
    }

    return payload;
  }

  async function importImage(
    attachment,
    gifOnly = false
  ) {
    requireValue(
      attachment &&
        (
          !attachment.size ||
          attachment.size <= 8 * 1024 * 1024
        ),
      'Joins un fichier de 8 Mo maximum.'
    );

    const bytes = await download(
      attachment.url,
      8 * 1024 * 1024
    );

    const metadata = await sharp(bytes, {
      limitInputPixels: 20000000,
    }).metadata();

    requireValue(
      ['gif', 'png', 'jpeg', 'webp']
        .includes(metadata.format),
      'Formats acceptés : PNG, JPG, WEBP ou GIF.'
    );

    requireValue(
      !gifOnly ||
        metadata.format === 'gif',
      'Pour l’animation, joins un vrai fichier GIF, ' +
        'pas une vidéo MP4.'
    );

    const folder = path.join(
      dir,
      'lootbox'
    );

    await fs.mkdir(folder, {
      recursive: true,
    });

    const file = path.join(
      folder,
      randomUUID() + '.' + metadata.format
    );

    // On conserve les octets d'origine :
    // le GIF reste animé.
    await fs.writeFile(file, bytes);

    return file;
  }

  async function ready(
    tiers = tiersFor(),
    style = get()
  ) {
    validTiers(tiers);

    requireValue(
      style.image &&
        style.animation,
      'Ajoute l’image d’accueil et le GIF dans « Images et GIF ».'
    );

    requireValue(
      tiers.every(t => t.image),
      'Ajoute une image dédiée pour chacun des cinq coffres.'
    );

    for (const file of [
      style.image,
      style.animation,
      ...tiers.map(t => t.image),
    ]) {
      try {
        await fs.access(file);
      } catch {
        throw new Error(
          'Un visuel manque dans le stockage. ' +
            'Remets-le dans le panneau /lootbox.'
        );
      }
    }

    return true;
  }

  function panel(owner, note = '') {
    const style = get();
    const tiers = tiersFor();

    const total = tiers.reduce(
      (n, t) => n + t.chance,
      0
    );

    const e = new EmbedBuilder()
      .setColor(style.color)
      .setTitle(
        '🎁 Configuration des lootboxes'
      )
      .setDescription(
        '**Les gains vont dans le classement commun SACEM.**\n\n' +
          `Image d’accueil : ${style.image ? '✅' : 'à ajouter'}\n` +
          `GIF d’ouverture : ${
            style.animation
              ? `✅ ${style.seconds} s`
              : 'à ajouter'
          }\n\n` +
          tiers
            .map(
              t =>
                `${t.icon} **${t.name}** · ` +
                `${t.amount} pts · ${t.chance} % · ` +
                `${t.image ? '✅ image' : '⚠️ image manquante'}`
            )
            .join('\n') +
          `\n\n${total === 100 ? '✅' : '⚠️'} ` +
          `Total des chances : **${total} %**\n\n` +
          'Choisis un coffre pour le personnaliser ou le tester. ' +
          'Puis sélectionne le salon de publication.'
      )
      .setFooter({
        text:
          'Les aperçus ne donnent aucun point ' +
          'et ne consomment pas le coffre du jour.',
      });

    const menu =
      new StringSelectMenuBuilder()
        .setCustomId(
          `slb:rarity:${owner}`
        )
        .setPlaceholder(
          'Modifier un coffre ou voir son aperçu'
        )
        .addOptions(
          ...tiers.map(t => ({
            label:
              `Modifier : ${t.name}`.slice(0, 100),
            value:
              `edit:${t.slot}`,
            description:
              `${t.chance} % · ${t.amount} points`,
            emoji: t.icon,
          })),

          ...tiers.map(t => ({
            label:
              `Aperçu : ${t.name}`.slice(0, 100),
            value:
              `preview:${t.slot}`,
            description:
              'GIF puis résultat, sans gagner de points',
            emoji: t.icon,
          }))
        );

    return {
      content: note,
      embeds: [e],
      files: [],
      attachments: [],
      allowedMentions: noPing,
      components: [
        row(
          button(
            `slb:text:${owner}`,
            'Message d’accueil'
          ),
          button(
            `slb:visuals:${owner}`,
            'Images et GIF'
          ),
          button(
            `slb:chances:${owner}`,
            'Chances et gains'
          )
        ),

        row(menu),

        row(
          new ChannelSelectMenuBuilder()
            .setCustomId(
              `slb:publish:${owner}`
            )
            .setPlaceholder(
              'Publier dans un salon'
            )
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement
            )
        ),

        row(
          button(
            `slb:welcome:${owner}`,
            'Aperçu de l’accueil'
          ),
          button(
            `slb:refresh:${owner}`,
            'Actualiser le panneau'
          )
        ),
      ],
    };
  }

  async function welcome() {
    const style = get();

    const embed =
      new EmbedBuilder()
        .setColor(style.color)
        .setTitle(style.title)
        .setDescription(
          style.text || null
        )
        .addFields(
          {
            name: '✨ Tes récompenses',
            value:
              'Des **points pour le classement SACEM**',
            inline: true,
          },
          {
            name: '🎁 Ton rendez-vous quotidien',
            value:
              '**Un coffre gratuit chaque jour**',
            inline: true,
          }
        )
        .setFooter({
          text:
            'Une ouverture par jour et par membre. ' +
            'Nouveau coffre à minuit, heure de Paris.',
        });

    return withImage(
      embed,
      style.image,
      [
        row(
          button(
            'loot',
            '🎁 ' + style.button,
            ButtonStyle.Primary
          ),
          button(
            'rank',
            '🏆 Classement'
          )
        ),
      ]
    );
  }

  async function result(
    claim,
    preview = false
  ) {
    const tier = claim.tier;

    const rankings =
      store.ranking(claim.season);

    const own = rankings.find(
      r => r.user === claim.user
    );

    const embed =
      new EmbedBuilder()
        .setColor(tier.color)
        .setAuthor({
          name:
            `${tier.icon} ${tier.name.toUpperCase()} · ` +
            `${preview ? 'APERÇU' : 'COFFRE DÉVOILÉ'}`,
        })
        .setTitle(tier.name)
        .setDescription(
          `**+${tier.amount} ` +
            `point${tier.amount > 1 ? 's' : ''}**\n\n` +
            `${
              tier.description ||
              'Un nouveau bonus pour ton classement !'
            }\n\n` +
            (
              preview
                ? '*Aperçu : aucun point attribué.*'
                : '✅ Tes points ont été ajoutés au classement.'
            )
        )
        .addFields(
          {
            name:
              preview
                ? '🎨 Mode aperçu'
                : '📊 Ton total',
            value:
              preview
                ? 'Aucun coffre consommé.'
                : `**${own?.points || 0} points**`,
            inline: true,
          },
          {
            name: '🏆 Ta place',
            value:
              preview
                ? 'Aucun effet sur le classement.'
                : own
                  ? `**#${own.rank}**`
                  : 'Pas encore classé.',
            inline: true,
          }
        )
        .setFooter({
          text:
            preview
              ? 'Ce coffre utilise son propre visuel.'
              : 'Ton prochain coffre sera disponible ' +
                'demain à minuit, heure de Paris.',
        });

    return withImage(
      embed,
      tier.image,
      preview
        ? []
        : [
            row(
              button(
                'rank',
                'Voir le classement'
              )
            ),
          ]
    );
  }

  function claim(
    user,
    name,
    tiers
  ) {
    return store.tx(() => {
      const day =
        dayParis(now());

      const key =
        `${day}:${user}`;

      const season =
        store.setting('season');

      const old =
        store.db.prepare(
          'SELECT json FROM sacem_loot_claims WHERE claim=?'
        ).get(key);

      const legacyClaim =
        store.db.prepare(
          "SELECT key FROM ledger " +
            "WHERE kind='loot' AND user=? AND key LIKE ? LIMIT 1"
        ).get(
          user,
          `loot:%:${day}:${user}`
        );

      requireValue(
        !old && !legacyClaim,
        'Tu as déjà ouvert ton coffre aujourd’hui. ' +
          'Tes points sont enregistrés. ' +
          'Reviens demain après minuit, heure de Paris !'
      );

      validTiers(tiers);

      let roll = randomInt(100);
      let tier;

      for (const t of tiers) {
        if (roll < t.chance) {
          tier = t;
          break;
        }

        roll -= t.chance;
      }

      requireValue(
        tier,
        'Les chances des coffres sont incorrectes.'
      );

      const saved = {
        user,
        name,
        season,
        day,
        created: now(),
        tier: structuredClone(tier),
      };

      store.award(
        `loot:${season}:${day}:${user}`,
        {
          season,
          kind: 'loot',
        },
        user,
        name,
        tier.amount,
        now()
      );

      store.db.prepare(
        'INSERT INTO sacem_loot_claims VALUES(?,?)'
      ).run(
        key,
        JSON.stringify(saved)
      );

      return saved;
    });
  }

  async function animate(
    i,
    saved,
    preview = false,
    style = get()
  ) {
    try {
      await i.editReply(
        await withImage(
          new EmbedBuilder()
            .setColor(style.color)
            .setTitle(
              '✨ Ton coffre s’ouvre…'
            )
            .setDescription(
              'Encore un instant… ta récompense arrive !'
            ),
          style.animation
        )
      );

      await wait(
        style.seconds * 1000
      );
    } catch (e) {
      console.error(
        'Animation lootbox :',
        e.code || e.name
      );
    }

    try {
      await i.editReply(
        await result(
          saved,
          preview
        )
      );
    } catch (e) {
      if (preview) {
        throw e;
      }

      await i.editReply({
        content:
          `🎁 Coffre ${saved.tier.name} : ` +
          `**+${saved.tier.amount} points** enregistrés ! ` +
          'Retrouve ton total dans le classement.',
        embeds: [],
        components: [
          row(
            button(
              'rank',
              'Voir le classement'
            )
          ),
        ],
        attachments: [],
        files: [],
        allowedMentions: noPing,
      });
    }
  }

  async function open(
    i,
    user,
    name
  ) {
    ensureEnabled();

    const tiers =
      tiersFor();

    const style =
      get();

    await ready(
      tiers,
      style
    );

    const saved =
      claim(
        user,
        name,
        tiers
      );

    onAward();

    return animate(
      i,
      saved,
      false,
      style
    );
  }

  async function refreshPublished(
    client
  ) {
    const failures = [];
    const list = [];

    for (const record of records()) {
      try {
        const channel =
          await client.channels.fetch(
            record.channel
          );

        await channel.messages.edit(
          record.message,
          await welcome()
        );

        list.push(record);
      } catch (e) {
        if (
          ![10003, 10008].includes(
            Number(e.code)
          )
        ) {
          list.push(record);
          failures.push(record.channel);
        }
      }
    }

    store.setting(
      'lootbox-messages-v2',
      list
    );

    return failures;
  }

  async function publish(
    i,
    channelId
  ) {
    await ready();

    const channel =
      await i.guild.channels.fetch(
        channelId
      );

    requireValue(
      channel &&
        [
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
        ].includes(channel.type),
      'Choisis un salon texte de ce serveur.'
    );

    const list = records();

    const old = list.find(
      b => b.channel === channelId
    );

    const payload =
      await welcome();

    let message;

    if (old) {
      try {
        message =
          await channel.messages.edit(
            old.message,
            payload
          );
      } catch (e) {
        if (
          Number(e.code) !== 10008
        ) {
          throw e;
        }
      }
    }

    if (!message) {
      message =
        await channel.send(
          payload
        );
    }

    store.setting(
      'lootbox-messages-v2',
      [
        ...list.filter(
          b => b.channel !== channelId
        ),
        {
          channel: channelId,
          message: message.id,
        },
      ]
    );

    return i.editReply(
      panel(
        i.user.id,
        `✅ Coffre publié ou actualisé dans <#${channelId}>.`
      )
    );
  }

  async function configure(i) {
    ensureEnabled();

    return i.editReply(
      panel(i.user.id)
    );
  }

  async function controls(i) {
    ensureEnabled();

    const [
      prefix,
      action,
      owner,
      slotText,
    ] = i.customId.split(':');

    requireValue(
      owner === i.user.id,
      'Ce panneau appartient à un autre membre du staff. ' +
        'Ouvre le tien avec /lootbox.'
    );

    requireValue(
      ['slb', 'slbf'].includes(prefix),
      'Commande de coffre inconnue.'
    );

    if (
      prefix === 'slb' &&
      [
        'text',
        'visuals',
        'chances',
      ].includes(action)
    ) {
      const style = get();

      let fields;
      let title;

      if (action === 'text') {
        title = 'Message d’accueil';

        fields = [
          textField(
            'title',
            'Titre',
            style.title,
            150
          ),
          textField(
            'text',
            'Texte et Markdown',
            style.text,
            3000,
            true,
            false
          ),
          textField(
            'color',
            'Couleur HEX',
            style.color,
            7
          ),
          textField(
            'button',
            'Texte du bouton',
            style.button,
            60
          ),
        ];
      } else if (
        action === 'visuals'
      ) {
        title =
          'Image d’accueil et GIF';

        fields = [
          upload(
            'image',
            'Image du coffre fermé',
            !style.image
          ),
          upload(
            'animation',
            'GIF d’ouverture',
            !style.animation
          ),
          textField(
            'seconds',
            'Durée du GIF : 1 à 15 secondes',
            style.seconds,
            2
          ),
        ];
      } else {
        title =
          'Chances et gains';

        fields =
          tiersFor().map(t =>
            textField(
              `t${t.slot}`,
              `${t.name.slice(0, 25)} : chance % ; points`,
              `${t.chance};${t.amount}`,
              20
            )
          );
      }

      return i.showModal(
        modal(
          `slbf:${action}:${owner}`,
          title,
          ...fields
        )
      );
    }

    if (
      prefix === 'slb' &&
      action === 'rarity'
    ) {
      const [
        choice,
        raw,
      ] = i.values[0].split(':');

      const slot =
        Number(raw);

      const tier =
        tiersFor()[slot];

      requireValue(
        Number.isInteger(slot) &&
          tier,
        'Coffre introuvable.'
      );

      if (choice === 'edit') {
        return i.showModal(
          modal(
            `slbf:rarity:${owner}:${slot}`,
            'Personnaliser ce coffre',

            textField(
              'name',
              'Nom du coffre',
              tier.name,
              80
            ),

            textField(
              'description',
              'Texte après ouverture',
              tier.description,
              1500,
              true,
              false
            ),

            textField(
              'gain',
              'Chance % ; points',
              `${tier.chance};${tier.amount}`,
              20
            ),

            textField(
              'color',
              'Couleur HEX',
              tier.color,
              7
            ),

            upload(
              'image',
              'Image dédiée à CE coffre',
              !tier.image
            )
          )
        );
      }

      requireValue(
        choice === 'preview' &&
          tier.image &&
          get().animation,
        'Ajoute le GIF et l’image de ce coffre avant de tester.'
      );

      await i.deferReply({
        flags: 64,
      });

      return animate(
        i,
        {
          user: owner,
          season:
            store.setting('season'),
          tier,
        },
        true
      );
    }

    if (
      prefix === 'slb' &&
      action === 'refresh'
    ) {
      await i.deferUpdate();

      return i.editReply(
        panel(owner)
      );
    }

    if (
      prefix === 'slb' &&
      action === 'welcome'
    ) {
      await i.deferReply({
        flags: 64,
      });

      const payload =
        await welcome();

      payload.components = [];

      return i.editReply(
        payload
      );
    }

    await i.deferReply({
      flags: 64,
    });

    return serial(async () => {
      if (
        prefix === 'slb' &&
        action === 'publish'
      ) {
        return publish(
          i,
          i.values[0]
        );
      }

      requireValue(
        prefix === 'slbf',
        'Action inconnue. Relance /lootbox.'
      );

      const value = key =>
        i.fields
          .getTextInputValue(key)
          .trim();

      const parseGain = input => {
        const m =
          /^(\d{1,3})\s*;\s*(\d{1,7})$/.exec(input);

        requireValue(
          m &&
            +m[1] <= 100 &&
            +m[2] >= 1 &&
            +m[2] <= 1000000,
          'Format attendu : chance;points, par exemple 60;1.'
        );

        return {
          chance: +m[1],
          amount: +m[2],
        };
      };

      if (action === 'text') {
        const title =
          value('title');

        const text =
          i.fields.getTextInputValue(
            'text'
          );

        const label =
          value('button');

        requireValue(
          title && label,
          'Le titre et le texte du bouton sont obligatoires.'
        );

        store.setting(
          'lootbox-style-v2',
          {
            ...get(),
            title,
            text,
            button: label,
            color:
              validColor(
                value('color')
              ),
          }
        );
      } else if (
        action === 'visuals'
      ) {
        const seconds =
          Number(value('seconds'));

        requireValue(
          Number.isInteger(seconds) &&
            seconds >= 1 &&
            seconds <= 15,
          'Durée attendue : de 1 à 15 secondes.'
        );

        const image =
          uploaded(i, 'image');

        const animation =
          uploaded(i, 'animation');

        const changes = {
          seconds,
        };

        if (image) {
          changes.image =
            await importImage(image);
        }

        if (animation) {
          changes.animation =
            await importImage(
              animation,
              true
            );
        }

        store.setting(
          'lootbox-style-v2',
          {
            ...get(),
            ...changes,
          }
        );
      } else if (
        action === 'rarity'
      ) {
        const slot =
          Number(slotText);

        requireValue(
          Number.isInteger(slot) &&
            slot >= 0 &&
            slot < 5,
          'Rareté invalide.'
        );

        const name =
          value('name');

        requireValue(
          name,
          'Le nom du coffre est obligatoire.'
        );

        const updated = {
          name,

          description:
            i.fields.getTextInputValue(
              'description'
            ),

          color:
            validColor(
              value('color')
            ),

          ...parseGain(
            value('gain')
          ),
        };

        const image =
          uploaded(i, 'image');

        if (image) {
          updated.image =
            await importImage(image);
        }

        const tiers =
          tiersFor();

        tiers[slot] = {
          ...tiers[slot],
          ...updated,
        };

        store.setting(
          'lootbox-tiers-v2',
          tiers
        );
      } else if (
        action === 'chances'
      ) {
        const tiers =
          tiersFor().map(t => ({
            ...t,
            ...parseGain(
              value(`t${t.slot}`)
            ),
          }));

        validTiers(tiers);

        store.setting(
          'lootbox-tiers-v2',
          tiers
        );
      } else {
        throw new Error(
          'Action inconnue.'
        );
      }

      let note =
        '✅ Modifications enregistrées.';

      try {
        validTiers(
          tiersFor()
        );
      } catch (e) {
        note +=
          '\n⚠️ ' + e.message;
      }

      const failures =
        await refreshPublished(
          i.client
        );

      if (failures.length) {
        note +=
          '\n⚠️ Certains messages n’ont pas pu être actualisés. ' +
          'Vérifie les permissions du bot.';
      }

      return i.editReply(
        panel(
          owner,
          note
        )
      );
    });
  }

  return {
    configure,
    controls,
    open,
    get,
    panel,
    tiersFor,
    ready,
    claim,
    welcome,
    result,
    refreshPublished,
  };
}

module.exports = {
  addLootboxCommand,
  createLootbox,
  DEFAULT_TIERS,
  validTiers,
  dayParis,
};
