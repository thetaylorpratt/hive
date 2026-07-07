/**
 * Curated emoji shortcode map for `:name:` completion (Notion/Slack/GitHub
 * conventions). Deliberately small — the macOS picker (⌃⌘Space) covers the
 * long tail; this covers what people type without thinking.
 */

export const EMOJI: Record<string, string> = {
  // faces
  smile: "😄", grin: "😁", joy: "😂", rofl: "🤣", slight_smile: "🙂",
  wink: "😉", blush: "😊", heart_eyes: "😍", thinking: "🤔", neutral: "😐",
  sweat_smile: "😅", cry: "😢", sob: "😭", angry: "😠", scream: "😱",
  zany: "🤪", shush: "🤫", mind_blown: "🤯", sunglasses: "😎", nerd: "🤓",
  melting: "🫠", salute: "🫡", skull: "💀", clown: "🤡", ghost: "👻",
  // gestures & people
  thumbsup: "👍", "+1": "👍", thumbsdown: "👎", "-1": "👎", ok_hand: "👌",
  wave: "👋", clap: "👏", raised_hands: "🙌", pray: "🙏", muscle: "💪",
  point_up: "☝️", point_right: "👉", crossed_fingers: "🤞", handshake: "🤝",
  eyes: "👀", brain: "🧠", facepalm: "🤦", shrug: "🤷", dancer: "💃",
  // work & objects
  fire: "🔥", rocket: "🚀", sparkles: "✨", star: "⭐", zap: "⚡",
  boom: "💥", tada: "🎉", confetti: "🎊", trophy: "🏆", medal: "🥇",
  check: "✅", white_check_mark: "✅", x: "❌", warning: "⚠️", sos: "🆘",
  question: "❓", exclamation: "❗", bulb: "💡", memo: "📝", pencil: "✏️",
  book: "📖", books: "📚", bookmark: "🔖", pushpin: "📌", paperclip: "📎",
  folder: "📁", inbox: "📥", outbox: "📤", package: "📦", clipboard: "📋",
  calendar: "📅", clock: "🕐", hourglass: "⏳", stopwatch: "⏱️", alarm: "⏰",
  chart: "📊", chart_up: "📈", chart_down: "📉", bar_chart: "📊",
  mag: "🔍", key: "🔑", lock: "🔒", unlock: "🔓", shield: "🛡️",
  hammer: "🔨", wrench: "🔧", gear: "⚙️", link: "🔗", scissors: "✂️",
  bug: "🐛", robot: "🤖", computer: "💻", keyboard: "⌨️", phone: "📱",
  email: "📧", envelope: "✉️", bell: "🔔", no_bell: "🔕", mega: "📣",
  money: "💰", dollar: "💵", gem: "💎", gift: "🎁", art: "🎨",
  // nature & animals
  bee: "🐝", honeybee: "🐝", honey: "🍯", butterfly: "🦋", bird: "🐦",
  dog: "🐶", cat: "🐱", fox: "🦊", bear: "🐻", panda: "🐼", koala: "🐨",
  unicorn: "🦄", dragon: "🐉", turtle: "🐢", octopus: "🐙", whale: "🐳",
  snake: "🐍", crab: "🦀", shark: "🦈", owl: "🦉", eagle: "🦅",
  tree: "🌳", seedling: "🌱", four_leaf_clover: "🍀", rose: "🌹",
  sunflower: "🌻", cactus: "🌵", mushroom: "🍄", leaves: "🍃",
  sun: "☀️", moon: "🌙", cloud: "☁️", rain: "🌧️", snow: "❄️",
  rainbow: "🌈", ocean: "🌊", mountain: "⛰️", volcano: "🌋", earth: "🌍",
  // food & drink
  coffee: "☕", tea: "🍵", beer: "🍺", wine: "🍷", cocktail: "🍸",
  pizza: "🍕", burger: "🍔", taco: "🌮", sushi: "🍣", ramen: "🍜",
  cake: "🍰", birthday: "🎂", cookie: "🍪", donut: "🍩", ice_cream: "🍦",
  apple: "🍎", banana: "🍌", avocado: "🥑", peach: "🍑", strawberry: "🍓",
  // travel & activities
  car: "🚗", bike: "🚲", train: "🚆", airplane: "✈️", ship: "🚢",
  house: "🏠", office: "🏢", hospital: "🏥", school: "🏫", tent: "⛺",
  soccer: "⚽", basketball: "🏀", football: "🏈", tennis: "🎾", golf: "⛳",
  game: "🎮", dice: "🎲", dart: "🎯", guitar: "🎸", music: "🎵",
  // symbols & hearts
  heart: "❤️", orange_heart: "🧡", yellow_heart: "💛", green_heart: "💚",
  blue_heart: "💙", purple_heart: "💜", black_heart: "🖤", broken_heart: "💔",
  100: "💯", infinity: "♾️", recycle: "♻️", radioactive: "☢️",
  arrow_up: "⬆️", arrow_down: "⬇️", arrow_left: "⬅️", arrow_right: "➡️",
  red_circle: "🔴", green_circle: "🟢", yellow_circle: "🟡", blue_circle: "🔵",
  flag: "🚩", checkered_flag: "🏁", construction: "🚧", no_entry: "⛔",
};

export interface EmojiMatch {
  name: string;
  char: string;
}

export function searchEmoji(query: string, limit = 8): EmojiMatch[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const starts: EmojiMatch[] = [];
  const contains: EmojiMatch[] = [];
  for (const [name, char] of Object.entries(EMOJI)) {
    if (name.startsWith(q)) starts.push({ name, char });
    else if (name.includes(q)) contains.push({ name, char });
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}
