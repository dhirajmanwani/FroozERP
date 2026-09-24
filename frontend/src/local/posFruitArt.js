// The picture on a POS tile, chosen from the product's name.
//
// The drawings ship inside the app (posFruitArtShapes.js), so a tile never waits on the internet
// and a LOCAL_ONLY counter shows the same pictures as an online one. Generating pictures with an
// online image service was considered and not done: it would send every product name out of the
// shop, cost money per picture, and leave offline counters with blank tiles.
//
// A name that matches nothing gets no picture here, and the tile falls back to the fruit colour
// and first letter (posTileBadge). A wrong picture is worse than a letter: a cashier who sees a
// mango on the pomegranate tile picks the wrong tile.

import { FRUIT_SVGS } from "./posFruitArtShapes.js";

// Checked in this order, so a "Mango Juice Bottle" is a bottle and a "Mango Shake" is a shake,
// not a mango. Two-word entries match as a phrase: "custard apple" before "apple".
const ART_RULES = Object.freeze([
  ["gift_basket", ["basket", "baskets", "hamper", "hampers"]],
  ["gift_box", ["gift box", "gift", "gifts", "gifting"]],
  ["lunch_box", ["lunch box", "lunchbox", "tiffin"]],
  ["juice_bottle", ["bottle", "bottles"]],
  ["shake", ["shake", "shakes", "smoothie", "smoothies", "milkshake"]],
  ["juice_glass", ["juice", "juices", "mocktail", "slush", "cooler"]],
  ["chaat_bowl", ["chaat", "salad", "salads", "bowl", "bowls", "cup", "cups"]],
  ["custardapple", ["custard apple", "sitaphal", "sharifa"]],
  ["dragonfruit", ["dragon fruit", "dragonfruit", "pitaya"]],
  ["watermelon", ["watermelon", "tarbuj", "tarbooz", "tarbuz"]],
  ["muskmelon", ["muskmelon", "kharbuja", "kharbooja", "cantaloupe", "melon"]],
  ["pineapple", ["pineapple", "ananas"]],
  ["mango", ["mango", "mangoes", "aam", "alphonso", "kesar", "hapus", "langda", "dasheri", "totapuri", "badami", "safeda", "chausa"]],
  ["apple", ["apple", "apples", "seb", "shimla"]],
  ["orange", ["orange", "oranges", "kinnow", "santra", "malta", "mandarin"]],
  ["grapes", ["grape", "grapes", "angoor", "angur"]],
  ["pomegranate", ["pomegranate", "anar", "anaar"]],
  ["banana", ["banana", "bananas", "kela", "robusta", "elaichi"]],
  ["papaya", ["papaya", "papita"]],
  ["guava", ["guava", "amrud", "amrood"]],
  ["lemon", ["lemon", "lemons", "lime", "nimbu", "mosambi", "mausambi", "sweet lime"]],
  ["strawberry", ["strawberry", "strawberries"]],
  ["cherry", ["cherry", "cherries"]],
  ["chikoo", ["chikoo", "chiku", "sapota", "sapodilla"]],
  ["coconut", ["coconut", "nariyal", "tender coconut"]],
  ["kiwi", ["kiwi", "kiwis"]],
  ["pear", ["pear", "pears", "nashpati", "babugosha"]],
  ["plum", ["plum", "plums", "aloo bukhara", "alubukhara"]],
  ["peach", ["peach", "peaches", "aadu", "aaru"]],
  ["litchi", ["litchi", "lychee", "lichi"]],
  ["jamun", ["jamun", "java plum"]],
  ["avocado", ["avocado", "avocados", "butter fruit"]],
  ["blueberry", ["blueberry", "blueberries"]],
  ["fig", ["fig", "figs", "anjeer", "anjir"]],
  ["dates", ["date", "dates", "khajur", "khajoor"]],
]);

const wordsOf = (text) => String(text ?? "").toLowerCase().split(/[^a-z]+/).filter(Boolean);

/** The drawing's key for a product name, or null when no drawing fits. */
export function fruitArtKeyFor(name) {
  const words = wordsOf(name);
  if (!words.length) return null;
  const joined = ` ${words.join(" ")} `;
  const matches = (entry) => (entry.includes(" ") ? joined.includes(` ${entry} `) : words.includes(entry));
  for (const [key, vocabulary] of ART_RULES) {
    if (vocabulary.some(matches)) return key;
  }
  return null;
}

/** The SVG markup for a product name, or null. Markup comes only from the bundled table. */
export function fruitArtFor(name) {
  const key = fruitArtKeyFor(name);
  return key && FRUIT_SVGS[key] ? { key, svg: FRUIT_SVGS[key] } : null;
}

export const FRUIT_ART_KEYS = Object.freeze(ART_RULES.map(([key]) => key));
