'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');

const {
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

function addLootboxCommand(root) {
  root.addSubcommand(o => {
    o
      .setName('lootbox')
      .setDescription('Publier ou modifier le coffre quotidien');

    o.addChannelOption(x =>
      x
        .setName('salon')
        .setDescription('Salon du coffre')
        .addChannelTypes(0)
        .setRequired(true)
    );

    for (const [name, description, max] of [
      ['titre', 'Titre du coffre', 150],
      ['texte', 'Texte du message public', 3000],
      ['bouton', 'Texte du bouton', 80],
      ['couleur', 'Couleur HEX, par exemple #7046D3', 7],
    ]) {
      o.addStringOption(x =>
        x
          .setName(name)
          .setDescription(description)
          .setMaxLength(max)
      );
    }

    for (const [name, description] of [
      ['image', 'Image du coffre fermé : joindre le fichier'],
      ['animation', 'GIF animé pendant l’ouverture : joindre le fichier'],
      ['resultat', 'Image ou GIF affiché avec les points gagnés'],
    ]) {
      o.addAttachmentOption(x =>
        x
          .setName(name)
          .setDescription(description)
      );
    }

    o.addIntegerOption(x =>
      x
        .setName('duree')
        .setDescription(
          'Durée de l’ouverture en secondes, de 2 à 10'
        )
        .setMinValue(2)
        .setMaxValue(10)
    );

    o.addBooleanOption(x =>
      x
        .setName('effacer_visuels')
        .setDescription(
          'Retirer les anciens visuels avant d’appliquer ceux joints'
        )
    );

    return o;
  });
}

function createLootbox({
  store,
  engine,
  dir,
  enabled,
  download,
  onAward,
  wait = ms =>
    new Promise(resolve => setTimeout(resolve, ms)),
}) {
  const defaults = {
    title: '🎁 Ton coffre du jour',

    text:
      'Un coffre à ouvrir chaque jour.\n\n' +
      'Clique sur le bouton pour découvrir tes points ' +
      'et faire avancer ton classement !',

    button: 'Ouvrir mon coffre',
    color: '#7046D3',
    seconds: 4,
  };

  const get = () => ({
    ...defaults,
    ...(store.setting('lootbox-ui') || {}),
  });

  const makeEmbed = (ui, title, description) =>
    new EmbedBuilder()
      .setColor(ui.color)
      .setTitle(title)
      .setDescription(description)
      .setFooter({
        text:
          'SACEM · Un coffre par jour · Heure de Paris',
      });

  const buttons = ui => [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('loot')
        .setLabel(ui.button)
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🎁'),

      new ButtonBuilder()
        .setCustomId('rank')
        .setLabel('Classement')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🏆')
    ),
  ];

  async function withImage(
    embed,
    file,
    components = []
  ) {
    const payload = {
      content: '',
      embeds: [embed],
      components,
      attachments: [],
      allowedMentions: { parse: [] },
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

  async function saveImage(attachment) {
    const bytes = await download(
      attachment.url,
      8 * 1024 * 1024
    );

    const metadata = await sharp(bytes, {
      limitInputPixels: 20000000,
    }).metadata();

    if (
      !['gif', 'png', 'jpeg', 'webp']
        .includes(metadata.format)
    ) {
      throw new Error(
        'Joins une image PNG, JPG, WEBP ou GIF ' +
        'de 8 Mo maximum.'
      );
    }

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

    // Le fichier original est conservé :
    // un GIF reste animé.
    await fs.writeFile(file, bytes);

    return file;
  }

  async function configure(i) {
    if (!enabled) {
      throw new Error(
        'Mets ENABLE_LOOTBOX=true dans Railway, ' +
        'puis redéploie.'
      );
    }

    const old = get();
    const ui = { ...old };

    for (const [option, key] of [
      ['titre', 'title'],
      ['texte', 'text'],
      ['bouton', 'button'],
      ['couleur', 'color'],
    ]) {
      const value =
        i.options.getString(option);

      if (value !== null) {
        ui[key] = value;
      }
    }

    if (
      !/^#[0-9a-f]{6}$/i.test(ui.color)
    ) {
      throw new Error(
        'Couleur attendue : #7046D3, par exemple.'
      );
    }

    if (
      !ui.title.trim() ||
      !ui.button.trim()
    ) {
      throw new Error(
        'Le titre et le bouton ne peuvent pas être vides.'
      );
    }

    const seconds =
      i.options.getInteger('duree');

    if (seconds !== null) {
      ui.seconds = seconds;
    }

    if (
      i.options.getBoolean('effacer_visuels')
    ) {
      for (const key of [
        'image',
        'animation',
        'resultat',
      ]) {
        delete ui[key];
      }
    }

    for (const key of [
      'image',
      'animation',
      'resultat',
    ]) {
      const attachment =
        i.options.getAttachment(key);

      if (attachment) {
        ui[key] = await saveImage(
          attachment
        );
      }
    }

    const channel =
      i.options.getChannel('salon');

    const payload = await withImage(
      makeEmbed(
        ui,
        ui.title,
        ui.text
      ),
      ui.image,
      buttons(ui)
    );

    let message;

    if (
      old.channel === channel.id &&
      old.message
    ) {
      try {
        message =
          await channel.messages.edit(
            old.message,
            payload
          );
      } catch (e) {
        // Message supprimé :
        // on peut en publier un nouveau.
        if (e.code !== 10008) {
          throw e;
        }
      }
    }

    if (!message) {
      message = await channel.send(
        payload
      );
    }

    ui.channel = channel.id;
    ui.message = message.id;

    store.setting(
      'lootbox-ui',
      ui
    );

    return i.editReply({
      content:
        `Coffre prêt dans <#${channel.id}>. ` +
        'Réutilise /sacem lootbox dans ce salon ' +
        'pour le modifier.',

      embeds: [],
      components: [],
    });
  }

  async function open(i, user, name) {
    if (!enabled) {
      throw new Error(
        'La lootbox n’est pas activée.'
      );
    }

    const ui = get();

    // Les points sont enregistrés avant l’animation.
    // Un clic répété ou un redémarrage ne permet
    // donc pas d’obtenir un deuxième gain.
    const points = engine.loot(
      user,
      name
    );

    onAward();

    try {
      await i.editReply(
        await withImage(
          makeEmbed(
            ui,
            '✨ Ouverture en cours…',
            'Ton coffre s’ouvre…'
          ),
          ui.animation || ui.image
        )
      );

      await wait(
        ui.seconds * 1000
      );
    } catch {
      // Même si Discord refuse le GIF,
      // on tente de montrer le résultat.
    }

    const season =
      store.setting('season');

    const own = store
      .ranking(season)
      .find(x => x.user === user);

    const embed = makeEmbed(
      ui,

      points
        ? '🎉 Le coffre est ouvert !'
        : '🎁 Le coffre est ouvert !',

      `Tu gagnes **${points} ` +
      `point${points > 1 ? 's' : ''}** !\n\n` +
      `🏆 Ton total : **${own?.points || 0} points**\n\n` +
      'Reviens demain pour ouvrir ton prochain coffre.'
    );

    const components = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('rank')
          .setLabel('Voir le classement')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('🏆')
      ),
    ];

    try {
      return await i.editReply(
        await withImage(
          embed,
          ui.resultat || ui.image,
          components
        )
      );
    } catch {
      return i.editReply({
        content: '',
        embeds: [
          embed.setImage(null),
        ],
        components,
        attachments: [],
        allowedMentions: { parse: [] },
      });
    }
  }

  return {
    configure,
    open,
    get,
  };
}

module.exports = {
  addLootboxCommand,
  createLootbox,
};
