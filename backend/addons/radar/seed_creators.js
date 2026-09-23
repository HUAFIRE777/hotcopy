// 2026-09-23 核对各频道公开页面的 canonical /channel/ID，不能把这份精选名单称为官方排名。
const VERIFIED_AT = Date.parse('2026-09-23T00:00:00Z');
const SEED_CREATORS = Object.freeze([
  { id: 'UCXUPKJO5MZQN11PqgIvyuvQ', name: 'Andrej Karpathy', category: 'ai', source: 'https://www.youtube.com/@AndrejKarpathy' },
  { id: 'UCsBjURrPoezykLs9EqgamOA', name: 'Fireship', category: 'tech', source: 'https://www.youtube.com/@Fireship' },
  { id: 'UCSHZKyawb77ixDdsGog4iWA', name: 'Lex Fridman', category: 'ai', source: 'https://www.youtube.com/@lexfridman' },
  { id: 'UCcefcZRL2oaA_uBNeo5UOWg', name: 'Y Combinator', category: 'business', source: 'https://www.youtube.com/@ycombinator' },
  { id: 'UCbfYPyITQ-7l4upoX8nvctg', name: 'Two Minute Papers', category: 'ai', source: 'https://www.youtube.com/@TwoMinutePapers' },
  { id: 'UCEgYhf84VjXDz-W7a9-rdCQ', name: 'Two Bit da Vinci', category: 'tech', source: 'https://www.youtube.com/@TwoBitdaVinci' },
  { id: 'UCawZsQWqfGSbCI5yjkdVkTA', name: 'Matthew Berman', category: 'ai', source: 'https://www.youtube.com/@matthew_berman' },
  { id: 'UCNJ1Ymd5yFuUPtn21xtRbbw', name: 'AI Explained', category: 'ai', source: 'https://www.youtube.com/channel/UCNJ1Ymd5yFuUPtn21xtRbbw' },
  { id: 'UCJS9pqu9BzkAMNTmzNMNhvg', name: 'Google Cloud Tech', category: 'tech', source: 'https://www.youtube.com/@googlecloudtech' },
  { id: 'UCyaN6mg5u8Cjy2ZI4ikWaug', name: 'My First Million', category: 'business', source: 'https://www.youtube.com/@MyFirstMillionPod' },
  { id: 'UCGq-a57w-aPwyi3pW7XLiHw', name: 'The Diary Of A CEO', category: 'business', source: 'https://www.youtube.com/@TheDiaryOfACEO' },
  { id: 'UCESLZhusAkFfsNsApnjF_Cg', name: 'All-In Podcast', category: 'business', source: 'https://www.youtube.com/@allin' },
  { id: 'UC2D2CMWXMOVWx7giW1n3LIg', name: 'Andrew Huberman', category: 'growth', source: 'https://www.youtube.com/@hubermanlab' },
  { id: 'UCznv7Vf9nBdJYvBagFdAHWw', name: 'Tim Ferriss', category: 'growth', source: 'https://www.youtube.com/@timferriss' },
  { id: 'UCBJycsmduvYEL83R_U4JriQ', name: 'Marques Brownlee', category: 'tech', source: 'https://www.youtube.com/@mkbhd' },
  { id: 'UCddiUEpeqJcYeBxX1IVBKvQ', name: 'The Verge', category: 'tech', source: 'https://www.youtube.com/@TheVerge' },
  { id: 'UCqcbQf6yw5KzRoDDcZ_wBSw', name: 'Wes Roth', category: 'ai', source: 'https://www.youtube.com/@WesRoth' },
  { id: 'UCXl4i9dYBrFOabk0xGmbkRA', name: 'Dwarkesh Patel', category: 'business', source: 'https://www.youtube.com/@DwarkeshPatel' },
  { id: 'UC6t1O76G0jYXOAoYCm153dA', name: "Lenny's Podcast", category: 'business', source: 'https://www.youtube.com/@LennysPodcast' },
  { id: 'UCoOae5nYA7VqaXzerajD0lg', name: 'Ali Abdaal', category: 'growth', source: 'https://www.youtube.com/@aliabdaal' }
]);

function seedCreators(db) {
  const insert = db.prepare(`
    INSERT INTO radar_creators
      (channel_id, category, channel_name, channel_url, curated_rank, verified_source, verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      category = excluded.category,
      channel_name = excluded.channel_name,
      channel_url = excluded.channel_url,
      curated_rank = excluded.curated_rank,
      verified_source = excluded.verified_source,
      verified_at = excluded.verified_at
  `);
  db.transaction(() => {
    SEED_CREATORS.forEach((creator, index) => {
      insert.run(
        creator.id, creator.category, creator.name,
        `https://www.youtube.com/channel/${creator.id}`,
        index + 1, creator.source, VERIFIED_AT
      );
    });
  })();
  return SEED_CREATORS.length;
}

module.exports = { SEED_CREATORS, VERIFIED_AT, seedCreators };
