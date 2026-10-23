'use strict';

module.exports = {
  name: 'SACEM · Le studio',
  color: '#7046D3',

  blind: {
    durations: [2, 5, 10],
    points: [10, 5, 3],
    answerSeconds: 15,
  },

  artist: {
    blur: [90, 60, 25],
    pixels: [14, 40, 150],
    sigma: [18, 9, 3],
    points: [10, 5, 3],
    answerSeconds: 15,
  },

  quiz: {
    seconds: 10,
    maxPoints: 10,
    minPoints: 2,
  },

  loot: [
    { points: 0, weight: 50 },
    { points: 1, weight: 35 },
    { points: 2, weight: 12 },
    { points: 5, weight: 3 },
  ],

  text: {
    home:
      '**Un morceau, un visage, une question… à toi de trouver.**\n\n' +
      '🎧 **Blind test** : 2, 5 puis 10 secondes d’extrait.\n' +
      '👀 **Qui est-ce ?** : le portrait devient progressivement plus clair.\n' +
      '🧠 **Quiz** : 10 secondes par question, avec un bonus de rapidité.\n\n' +
      'Les points des trois jeux s’additionnent dans le même classement.',

    blind:
      'Écoute l’extrait, puis choisis : **Répondre** ou **Plus d’extrait**.\n\n' +
      'Une mauvaise réponse termine ta participation à ce morceau. ' +
      'Tu peux passer au palier suivant sans proposer de réponse.',

    artist:
      'Reconnais l’artiste ou le groupe avant que la photo ne devienne trop nette.\n\n' +
      'Choisis **Répondre** ou **Déflouter**. ' +
      'Une mauvaise réponse termine ta participation à ce portrait.',

    quiz:
      'Une seule participation par édition. **10 secondes par question.** ' +
      'Plus ta bonne réponse arrive vite, plus elle rapporte de points. ' +
      'Une erreur vaut 0 point, puis tu peux passer à la question suivante.',

    wrong:
      '❌ Ce n’est pas la bonne réponse. Ta participation à cette animation est terminée. ' +
      'La solution sera publiée à la clôture.',

    correct:
      '🎉 Bien joué ! Tes points sont enregistrés dans le classement commun.',

    timeout:
      '⏱️ Temps écoulé pour ce palier. Passe au suivant s’il en reste un.',

    used:
      'Tu as déjà terminé cette animation. Tu ne peux pas rejouer pour gagner des points.',

    late:
      'Cette animation n’est pas ouverte, ou sa date de clôture est passée.',
  },
};
