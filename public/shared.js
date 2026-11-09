// Shared between the browser and the server. Keep it dependency-free.

export const FREE_PLAYER_LIMIT = 8;
export const MAX_PLAYERS = 50;
export const QUESTION_SECONDS = 20;

// The 10 guided prompts the host answers. `q` is the question template used by
// the no-AI fallback; `decoys` are generic wrong answers for that fallback.
export const PROMPTS = [
  {
    id: 'karaoke',
    label: 'Their go-to karaoke song',
    placeholder: 'e.g. "Total Eclipse of the Heart", every single time',
    q: "What's {n}'s go-to karaoke song?",
    decoys: ["Bohemian Rhapsody", "Wonderwall", "Don't Stop Believin'", 'Mr. Brightside', 'I Will Survive', 'Sweet Caroline'],
  },
  {
    id: 'habit',
    label: 'Their most annoying habit',
    placeholder: 'e.g. leaves exactly one sip of coffee in every mug',
    q: "Which of these is {n}'s most annoying habit?",
    decoys: ['Replying "k" to long texts', 'Keeping 87 browser tabs open', 'Saying "we should hang out" and never doing it', 'Stealing fries off your plate', 'Leaving voice notes instead of texting'],
  },
  {
    id: 'embarrassing',
    label: 'Most embarrassing moment',
    placeholder: 'e.g. waved back at someone who was waving at the person behind them… at their own graduation',
    q: 'Which embarrassing moment ACTUALLY happened to {n}?',
    decoys: ['Got locked out of the house wearing only a towel', 'Called their teacher "Mom" in front of the whole class', 'Fell asleep on a first date', 'Sent a text complaining about someone… to that someone'],
  },
  {
    id: 'order',
    label: 'What they always order',
    placeholder: 'e.g. chicken tenders, even at a sushi restaurant',
    q: 'What does {n} ALWAYS order?',
    decoys: ['A large iced oat-milk latte', 'Whatever the server recommends', 'Spicy margarita, extra Tajín', 'Two appetizers instead of a main', 'A Caesar salad and then half of yours'],
  },
  {
    id: 'talent',
    label: 'A hidden talent',
    placeholder: 'e.g. can name every Pokémon in order',
    q: "What's {n}'s secret hidden talent?",
    decoys: ['Can solve a Rubik\'s cube in under a minute', 'Fluent in Klingon', 'Can whistle with their fingers', 'Professional-level juggler', 'Remembers every phone number they\'ve ever seen'],
  },
  {
    id: 'firstjob',
    label: 'Their first job',
    placeholder: 'e.g. dressed as a giant hot dog outside a gas station',
    q: "What was {n}'s very first job?",
    decoys: ['Lifeguard at a public pool', 'Movie theater popcorn scooper', 'Golf caddy', 'Pizza delivery driver', 'Mall Santa\'s elf'],
  },
  {
    id: 'crush',
    label: 'Celebrity crush',
    placeholder: 'e.g. Guy Fieri (unironically)',
    q: "Who is {n}'s celebrity crush?",
    decoys: ['Ryan Gosling', 'Zendaya', 'Pedro Pascal', 'Rihanna', 'Keanu Reeves', 'Taylor Swift'],
  },
  {
    id: 'catchphrase',
    label: 'Something they say ALL the time',
    placeholder: 'e.g. "It is what it is"',
    q: 'Which phrase does {n} say constantly?',
    decoys: ['"Literally obsessed"', '"No because…"', '"Trust the process"', '"Let\'s circle back"', '"That\'s wild"'],
  },
  {
    id: 'bucket',
    label: 'Bucket-list dream',
    placeholder: 'e.g. see the Northern Lights from a glass igloo',
    q: "What's at the top of {n}'s bucket list?",
    decoys: ['Skydive over Dubai', 'Open a tiny bookshop', 'Run a marathon', 'Swim with whale sharks', 'Eat at every Michelin restaurant in Paris'],
  },
  {
    id: 'fear',
    label: 'Irrational fear',
    placeholder: 'e.g. geese. Specifically geese.',
    q: 'What is {n} irrationally afraid of?',
    decoys: ['Butterflies', 'Escalators', 'Balloons popping', 'Clowns', 'Talking on the phone'],
  },
];

export const PHOTO_KINDS = {
  whose: { label: 'Whose photo is this?', q: 'Whose photo is this?', answerHint: 'Whose is it? e.g. "Dani (age 4)"' },
  where: { label: 'Where was this taken?', q: 'Where was this photo taken?', answerHint: 'Where? e.g. "Grandma\'s pool in Tampa"' },
  what: { label: 'What happened next?', q: 'What happened right after this photo was taken?', answerHint: 'What happened? e.g. "The cake hit the floor"' },
};

export const PHOTO_DECOYS = {
  whose: ['The best man', 'Their mom', 'Their cousin Mike', 'A total stranger', 'Their roommate'],
  where: ['Las Vegas', "Grandma's basement", 'A Costco parking lot', 'Cancún', 'A Chuck E. Cheese'],
  what: ['Everyone cheered', 'Security got involved', 'They cried happy tears', 'The dog ran off with it', 'Someone fell in the pool'],
};

export function fill(template, name) {
  return template.replaceAll('{n}', name);
}
