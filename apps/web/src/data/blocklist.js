/**
 * Local common-password screening (UX-ONB-006).
 *
 * The check is a case-insensitive exact match against a small embedded
 * list of widely breached passwords, plus the same value with whitespace
 * removed (users often space out known words). The password never leaves
 * the device: no network request is made and no hash of the password is
 * recorded anywhere. The list is intentionally tiny and conservative —
 * the 15-character minimum is the primary defense; this screen only
 * rejects passwords built from the most predictable material.
 */

/** Lowercase, alphabetically grouped common-password corpus. */
const COMMON_PASSWORDS = Object.freeze(new Set([
  // Repeated and doubled classics (common once length floors apply).
  'passwordpassword', 'passwordpassword1', 'passw0rdpassw0rd',
  'qwertyuiopasdfgh', 'qwertyuiopasdfghjkl', 'qwertyqwerty123',
  'asdfghjklzxcvbnm', 'zxcvbnmasdfghjkl', 'qwertyuiop12345',
  'abc1234567891011', 'abcdefghij12345', 'aaaaaaaaaaaaaaaa',
  '1234567891011121', '1234567890123456', '1234567890qwe',
  'iloveyouiloveyou', 'iloveyouforever', 'trustno1trustno1',
  'letmeinletmein123', 'welcomeelcome123', 'welcomeeeee12345',
  'administrators1', 'administrator123', 'administration1',
  'secretpassword12', 'secretsecret123', 'sunshinesunshine1',
  'princessprincess', 'dragonlover1234', 'monkeymonkey123',
  'masterpassword12', 'masterofpuppets1', 'footballfootball1',
  'baseballbaseball', 'starwarsstarwars', 'whatever123456',
  'computercomputer', 'internetinternet1', 'playstation12345',
  'pokemonpokemon123', 'minecraft12345', 'fortnitefortnite',
  'googlegoogle1234', 'facebookfacebook', 'instagrampassword',
  'netflixnetflix12', 'snapchatsnapchat', 'tiktoktiktok123',
  'youtubeyoutube123', 'amazonamazon1234', 'applemusic12345',
  // Long keyboard walks and predictable extensions.
  '1qaz2wsx3edc4rfv', '1q2w3e4r5t6y7u8i', 'qazwsxedcrfvtgbyh',
  'poiuytrewqlkjhgf', 'mnbvcxzlkjhgfds', 'asdfghjklqwerty',
  '1472583691472583', '159753357159753', '741852963741852',
  '987654321qwerty', '1234qwerasdfzxcv', 'abcd1234abcd1234',
  'aaaa1234567890', 'abcdabcdabcd1234',
  // Sentences users believe are clever.
  'thisismypassword1', 'thisisthepassword', 'mypasswordis12345',
  'notmypassword123', 'passwordispassword', 'thequickbrownfox',
  'correcthorsebattery', 'correcthorse123', 'ihatemypassword1',
  'passwordforwork1', 'passwordforfacebook', 'newpassword12345',
  'changemechangeme', 'changemeforwork', 'temporarypassword',
  'temppassword1234', 'firstpassword123', 'workpassword1234',
  'homepassword12345', 'emailpassword123', 'gmailpassword1234',
  // Names, teams, and years (predictable personal material).
  'michaeljordan123', 'jordancarolina23', 'letsgopenguins1',
  'gobluegoblue123', 'rolltideroll123', 'gopackgo123456',
  'liverpoolfc1892', 'manchesterunited1', 'barcelonaforever',
  'realmadridreal1', 'fifaworldcup2018', 'superbowlchamps1',
  'hellokittyhello1', 'spongebobsquare1', 'harrypotter1234',
  'hermionegranger1', 'sakuranaruto123', 'pokemontrainer1',
  // Words + years / symbol suffixes users reach for.
  'summer2015summer', 'summer2016summer', 'summer2017summer',
  'summer2018summer', 'summer2019summer', 'summer2020summer',
  'summer2021summer', 'summer2022summer', 'summer2023summer',
  'winter2015winter', 'spring2023spring', 'january2023abcd',
  'password2020', 'password2021', 'password2022', 'password2023',
  'password2024', 'password123456', 'password123456789',
  'qwerty2020noway', 'iloveyou2020', 'iloveyou2023xyz',
]));

/**
 * Return true when the candidate is built from common-password material.
 * Matching folds case, trims surrounding whitespace, and also tries the
 * value with all internal whitespace removed.
 */
export function isCommonPassword(candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  const folded = candidate.trim().toLowerCase();
  if (!folded) return false;
  const despaced = folded.replace(/\s+/g, '');
  return COMMON_PASSWORDS.has(folded) || COMMON_PASSWORDS.has(despaced);
}

/** Exposed for unit tests: the frozen corpus size. */
export const BLOCKLIST_SIZE = COMMON_PASSWORDS.size;
