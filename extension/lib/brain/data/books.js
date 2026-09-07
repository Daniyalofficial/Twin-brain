/**
 * THE BUILT-IN BOOKSHELF — six success classics with COMPLETE original
 * commentary: the core idea, every major lesson explained in plain English
 * with a concrete action step, paraphrased wisdom, a 7-day starter plan and
 * honest guidance on who each book serves.
 *
 * All commentary is original paraphrase and teaching written for this app —
 * never reproduced text from the books. When you are ready, buy the originals.
 *
 * Book shape:
 *   { id, title, author, year, oneLine, why, coreIdea,
 *     lessons: [{ t: title, e: explanation, a: action }],
 *     quotes: [paraphrased wisdom], plan: [7 daily steps], who }
 */

export const SUCCESS_BOOKS = [
  {
    id: 'think-and-grow-rich',
    title: 'Think and Grow Rich',
    author: 'Napoleon Hill',
    year: 1937,
    oneLine: 'The founding text of personal success: a definite burning desire, organised into a plan and fed daily to your subconscious, moves people to riches of every kind.',
    why: 'Hill spent over twenty years interviewing hundreds of the most successful people of his era — Carnegie, Ford, Edison — looking for the common machinery of achievement. What he found was not luck or genius but a repeatable pattern of thinking, and this book is that pattern written down. Nearly ninety years later almost every modern success book is a footnote to it.',
    coreIdea: 'Thoughts become things when they are charged with emotion and repeated until the subconscious accepts them as instructions. Success starts with a definite chief aim — a precise goal written down with a deadline and an exact statement of what you will give in return — converted into a burning desire that survives rejection, poverty and ridicule. Hill argues the subconscious cannot tell the difference between a vividly imagined experience and a real one, so feeding it your goal daily (morning and night, aloud, with feeling) literally reprograms your automatic behaviour. Around that central engine he builds the supporting parts: specialised knowledge gathered through a plan, imagination sharpened by desire, decisions made quickly and changed slowly, persistence past the point where most people quit, and above all the mastermind — a small circle of aligned people whose combined intelligence multiplies your own. Fear, especially the fear of poverty and the fear of criticism, is identified as the chief brake, and giving before receiving as the hidden accelerator.',
    lessons: [
      { t: 'Desire must be definite and burning', e: 'Wishing is passive; Hill wants a desire so specific and so emotionally charged that your mind treats failure to achieve it as unacceptable. Vague goals produce vague effort, and vague effort produces vague results.', a: 'Write your exact goal with a number, a deadline, and what you will give in return — then read it aloud twice daily.' },
      { t: 'Faith is a state you can manufacture', e: 'Faith here is not religion but expectancy: the deep conviction that your plan will work. Hill teaches it is created by repetition of affirmation to the subconscious until doubt is crowded out.', a: 'Each morning, state your goal in present-tense, feeling-based language for two minutes — as if the result is already moving toward you.' },
      { t: 'Autosuggestion rewires the subconscious', e: 'The subconscious runs your automatic habits and accepts whatever you repeatedly feed it with emotion. Autosuggestion is the deliberate practice of choosing that input instead of leaving it to accidents and other people.', a: 'Never repeat your fears aloud. Replace each worry sentence with the sentence you would rather live by, said with feeling.' },
      { t: 'Specialised knowledge beats general knowledge', e: 'General information does not earn money; knowledge organised toward a definite purpose does. Henry Ford famously won a courtroom point by knowing exactly where his business knowledge lived — in the people around him.', a: 'List the three specific skills your goal demands, and schedule this week\'s first hour of study for the weakest one.' },
      { t: 'Imagination is the workshop of the mind', e: 'Hill separates synthetic imagination (recombining known ideas into new plans) from creative imagination (hunches and inspiration). Both are muscles — they strengthen with deliberate use and atrophy with neglect.', a: 'Spend fifteen minutes daily asking: what would this look like if it worked perfectly? Write every answer, even silly ones.' },
      { t: 'Organised planning turns desire into action', e: 'A desire without a plan is a daydream. Hill insists on a written, practical plan, and on replacing a failed plan immediately with a new one instead of abandoning the goal itself.', a: 'Break your goal into this quarter, this month, this week, and today — one written plan per level, reviewed weekly.' },
      { t: 'Decide fast, change slowly', e: 'Hill found successful people reached decisions promptly and changed them slowly, while unsuccessful people decided slowly and reversed constantly under others\' opinions. Procrastination is decision-fear wearing a disguise.', a: 'For your next real decision, set a twenty-four-hour deadline — decide within it and refuse to reopen it for thirty days.' },
      { t: 'Persistence is the insurance against failure', e: 'Temporary defeat arrives for everyone; the only permanent failure is quitting. Hill notes most people abandon their purpose at the first sign of opposition, exactly where breakthroughs usually wait.', a: 'Write your quit-conditions before you start (real evidence, not bad feelings), and treat every other setback as tuition.' },
      { t: 'The mastermind multiplies intelligence', e: 'No individual has enough experience or knowledge for a great purpose. A mastermind is a small group of capable people working in perfect harmony toward your plan — the combined mind thinks better than any member alone.', a: 'List five people whose skills complement your goal; approach one this month with a specific, generous proposal.' },
      { t: 'Energy must be transmuted, not wasted', e: 'Strong emotions — including physical desire — are raw power. Hill teaches redirecting that intensity into creative work rather than dissipating it; the most productive people are not calmer, they channel better.', a: 'When strong emotion hits, do not suppress it: open your project and put ten focused minutes of that energy into it.' },
      { t: 'The subconscious obeys what you repeat', e: 'Your subconscious works day and night on whatever dominates your thoughts. Feed it problems and it manufactures anxiety; feed it your definite chief aim and it works the problem in the background — this is the source of hunches.', a: 'Review your written goal in the last ten minutes before sleep — the subconscious processes what it receives at day\'s end.' },
      { t: 'Fear is the brake — name and dismantle it', e: 'Hill catalogues the six basic fears — poverty, criticism, ill health, loss of love, old age and death — and shows each is a habit of thought, inherited and reinforced, curable by the same autosuggestion that built it.', a: 'Write your biggest fear in one sentence, then write the smallest action that defies it — and do that action this week.' },
    ],
    quotes: [
      'Whatever the mind can conceive and believe, it can achieve.',
      'A quitting man never wins, and a winning man never quits.',
      'Every adversity carries with it the seed of an equivalent benefit.',
      'Opportunity often arrives dressed as hard work, which is why most people miss it.',
    ],
    plan: [
      'Day 1: Write your definite chief aim — exact amount, exact date, exact service you give in return.',
      'Day 2: Read it aloud morning and night with emotion; begin believing it on purpose.',
      'Day 3: Draft the first organised plan: quarter, month, week, today.',
      'Day 4: List the specialised knowledge your plan requires and book your first study hour.',
      'Day 5: Identify your dominant fear and write one defiant action against it.',
      'Day 6: Name three potential mastermind partners and message the first one.',
      'Day 7: Review the week honestly: what moved, what stalled, what changes in plan version two.',
    ],
    who: 'Anyone starting from zero who needs the psychological foundation before tactics — this is the mindset layer every other success book assumes you already built.',
  },
  {
    id: 'rich-dad-poor-dad',
    title: 'Rich Dad Poor Dad',
    author: 'Robert T. Kiyosaki',
    year: 1997,
    oneLine: 'The rich do not work for money — they make money work for them, by spending their lives buying assets while everyone else buys liabilities they believe are assets.',
    why: 'Kiyosaki grew up with two fathers: his educated, hard-working biological father (poor dad, a PhD who struggled financially all his life) and his best friend\'s father (rich dad, an eighth-grade dropout who became one of Hawaii\'s wealthiest men). Comparing the two men\'s money beliefs became one of the best-selling personal-finance books in history, because it names the one distinction schools never teach: the difference between an asset and a liability.',
    coreIdea: 'Financial struggle is not caused by low income but by low financial literacy — people earn more and immediately buy more liabilities (bigger house, better car, newer phone), so expenses rise with income forever. Kiyosaki\'s entire system rests on one definition: an asset puts money in your pocket whether you work or not (rental property, dividends, a business that runs without you, royalties); a liability takes money out of your pocket (mortgage on your own house, car loans, credit-card debt, subscriptions). The poor and middle class buy liabilities they think are assets; the rich buy assets first and let the cash flow pay for luxuries later. Around this he builds supporting lessons: mind your own business (your job pays bills — your asset column builds wealth), understand taxes and corporations (the rich earn, spend, then pay tax on what remains through legal structures; employees earn, pay tax, then spend what is left), invent money (deals are seen, not found — financial intelligence recognises opportunities others walk past), and work to learn, not to earn (in your twenties, choose jobs for the skills they teach — sales, communication, systems — not the salary they pay). Fear and cynicism, he warns, are what actually keep people poor: fear of losing money stops people from starting, and cynicism lets the voices of doubt make decisions for them.',
    lessons: [
      { t: 'The rich do not work for money', e: 'Most people are ruled by two emotions — fear of having no money and desire for the things money buys — so they work harder at a job, get a raise, and immediately spend it, staying on the treadmill. The rich flip the pattern: they acquire things that generate money on its own.', a: 'Audit this month: what percentage of your income arrives without your hours? Write the number — it is your real financial report card.' },
      { t: 'Know the difference between an asset and a liability', e: 'The single most important rule: assets put money in your pocket, liabilities take it out. Your home, car and phone are liabilities under this definition — not insults, just accounting. Wealth is built by making the asset column larger than the expense column.', a: 'Draw two columns tonight. List everything you own under asset only if it produced cash last month. Be brutally honest.' },
      { t: 'Mind your own business', e: 'Your profession pays the bills; your business is your asset column. Ray Kroc sold franchises, not burgers — the real estate was the business. Kiyosaki wants you to keep your day job while your asset column quietly grows into a second income.', a: 'Choose one asset class to study this quarter (dividend stocks, rental property, a small online business) and open your first position or prototype within 90 days.' },
      { t: 'Understand taxes and the power of corporations', e: 'Employees earn, are taxed, then spend what is left. Business owners earn, spend legitimate expenses, and are taxed on what remains — the biggest legal advantage in the game. Financial IQ is accounting plus investing plus markets plus law, working together.', a: 'Book one session with a tax professional this year and ask one question: which of my expenses could legally sit inside a business structure?' },
      { t: 'The rich invent money', e: 'In the real world it is not the smart who get ahead but the bold. Opportunities are not found with the eyes but with the financial mind — a person with trained intelligence sees deals in the same market where everyone else sees risk.', a: 'Once a week, write down one money opportunity you noticed (a shop closing, a skill in demand, an underpriced listing). Train the seeing muscle.' },
      { t: 'Work to learn, not to earn', e: 'Kiyosaki took low-paying jobs on purpose — sales, shipping, construction — to install skills his portfolio would later need. He advises young people to seek work for what it teaches, especially selling and communication, the two skills that multiply every other skill.', a: 'Identify the one skill (usually selling, writing or negotiating) whose absence caps your income — and get reps in it this year, even cheaply.' },
      { t: 'Overcome the five obstacles', e: 'Even financially literate people are stopped by five things: fear of losing money, cynicism (doubting voices, internal and external), laziness disguised as busyness, bad habits that pay others before yourself, and arrogance that hides what you do not know.', a: 'Pick your dominant obstacle and write its exact cost: what has fear, cynicism or arrogance already taken from you?' },
      { t: 'Pay yourself first', e: 'When money is tight, the pressure should force you to find new income — not to raid your savings. Kiyosaki\'s rule: pay your asset column before your bills, and let the discomfort push you to earn more rather than to weaken.', a: 'Set an automatic transfer on payday: a fixed percentage to your asset column before anything else is touched. Start small but start.' },
      { t: 'Being broke is temporary; being poor is a mindset', e: 'Broke is a financial state that changes with cash flow; poor is an identity that says I can never afford it. Kiyosaki forces the question how can I afford it? — which opens the mind to solutions instead of closing it with a verdict.', a: 'Ban the sentence I cannot afford it from your vocabulary for thirty days; replace it every time with how could I afford it?' },
      { t: 'Cash flow is the real score', e: 'Net worth on paper flatters; cash flow tells the truth. Rich is measured by how many days you could survive if you stopped working today — passive income divided by monthly expenses converts money into time.', a: 'Compute your survival number: monthly passive income divided by monthly expenses. Improving it by 0.1 is more valuable than any luxury.' },
      { t: 'Teach and give to receive', e: 'Kiyosaki insists on generosity as strategy: teaching what you know deepens it, and giving starts flows — money, relationships, opportunities. The greedy hoarding mindset, he found, correlates with the scarcity it fears.', a: 'Teach one money lesson to someone younger this month — a sibling, cousin or friend. Notice how much sharper your own understanding becomes.' },
    ],
    quotes: [
      'The poor and the middle class work for money; the rich make money work for them.',
      'An asset puts money in your pocket; a liability takes it out — know which is which and buy assets.',
      'It is not how much money you make, but how much money you keep and how long it works for you.',
      'Winning means being unafraid to lose — in finance and in life.',
    ],
    plan: [
      'Day 1: Write your personal balance sheet — two columns: assets (things that paid you last month) and liabilities.',
      'Day 2: Write your cash-flow statement: every rupee in, every rupee out, from where to where.',
      'Day 3: Compute your survival number — passive income divided by monthly expenses.',
      'Day 4: Choose your first asset class to study; spend one hour learning how it actually produces cash.',
      'Day 5: Set up pay-yourself-first: an automatic transfer, however small, on payday.',
      'Day 6: List three skills that would raise your earned income; pick one to practise this month.',
      'Day 7: Replace one liability habit with an asset habit and write the new rule down where you will see it daily.',
    ],
    who: 'Anyone who earns money but never seems to keep it — the book that reprograms what you believe money even is, before any investing tactics.',
  },
  {
    id: 'how-to-win-friends',
    title: 'How to Win Friends and Influence People',
    author: 'Dale Carnegie',
    year: 1936,
    oneLine: 'People are moved by interest, appreciation and feeling understood — not by logic, arguments or being proven wrong; master that and doors open everywhere.',
    why: 'Carnegie ran the most popular adult-education course in America and distilled thirty years of watching thousands of businessmen, housewives and students try to change how they dealt with people. The book has sold over thirty million copies because its core discovery never ages: technical skill accounts for a minority of financial success, while the ability to lead, sell and work with people — a trainable skill — accounts for the rest.',
    coreIdea: 'Human beings are not creatures of logic but creatures of emotion, creatures bristling with prejudice and motivated by pride and vanity. Therefore the person who wants to influence others must stop pushing their own importance and start supplying what every human craves: to feel important, to be genuinely appreciated, and to be understood before being advised. Carnegie\'s rules cluster into a handful of laws. First, never criticize, condemn or complain — criticism wounds pride, triggers defensiveness and never produces lasting change; B. F. Skinner\'s animals learned faster by reward than punishment, and humans far more so. Second, give honest and sincere appreciation — not flattery, which is cheap and spotted instantly, but specific recognition of real effort. Third, become genuinely interested in other people — you make more friends in two months by becoming interested in them than in two years trying to get them interested in you. Fourth, talk in terms of the other person\'s interests and let them do most of the talking; the sweetest sound to anyone is their own name, and the rarest gift is full attention. Fifth, avoid arguments — you cannot win one, because even when you win, you lose goodwill; show respect for opinions, admit your own mistakes quickly and emphatically, and begin in a friendly way. Sixth, get the other person saying yes immediately (the Socratic method), let them feel the idea is theirs, and see everything from their point of view — ask yourself why they would want to do it. Influence, in Carnegie\'s system, is not manipulation; it only works when the interest in the other person is real, and people detect the difference with uncanny accuracy.',
    lessons: [
      { t: 'Do not criticize, condemn or complain', e: 'Criticism puts people on the defensive and strikes at their pride; it breeds resentment, never correction. Even criminals rarely blame themselves — if hardened convicts justify themselves, imagine the people you work and live with.', a: 'For seven days, catch every criticism before it leaves your mouth and replace it with a question or silence. Observe what changes.' },
      { t: 'Give honest, sincere appreciation', e: 'The deepest urge in human nature is the desire to be important. Flattery is generic and self-serving; appreciation is specific and about them — it is the difference between I admire what you did and here is exactly what was impressive about it.', a: 'Give one specific, sincere appreciation today — name the exact behaviour and its effect on you. No agenda attached.' },
      { t: 'Arouse in the other person an eager want', e: 'Bait the hook to suit the fish, not the angler: the only way to influence anyone is to talk about what they want and show them how to get it. Every action anyone ever took sprang from a desire — find theirs and speak to it.', a: 'Before your next request, write one sentence: what does this person want, and how does my request serve that? Then lead with it.' },
      { t: 'Become genuinely interested in people', e: 'You can win more friendship in two months by being interested in others than in two years of trying to make them interested in you. Interest cannot be faked long — but it can be cultivated by real curiosity about how people got where they are.', a: 'In your next conversation, ask three follow-up questions about something they said before mentioning anything about yourself.' },
      { t: 'Smile — and remember names', e: 'A smile says I like you, you make me happy, I am glad to see you — and it costs nothing while buying much. A person\'s name is to that person the sweetest sound in any language; remembering it is a subtle, powerful compliment.', a: 'Smile at the first second of your next meeting, and use the person\'s name twice in the conversation.' },
      { t: 'Be a good listener; encourage others to talk', e: 'Most people prefer a good listener to a good talker, yet listeners are rarer than any other compliment. Real attention — eyes, body, follow-up questions — is something almost no one receives, which is why it works so completely.', a: 'In one conversation today, let the other person hold the floor for ten minutes with nothing from you but engaged questions.' },
      { t: 'Talk in terms of the other person\'s interests', e: 'The royal road to a person\'s heart is to talk about the things they treasure most. Theodore Roosevelt studied his visitors\' interests the night before — and became the most beloved conversationalist of his era by preparation, not charm.', a: 'Before meeting someone, find one thing they care about (their work, hobby, recent post) and open the conversation there.' },
      { t: 'Make the other person feel important — sincerely', e: 'The golden rule in practice: every person you meet feels superior to you in some way, and the sure path to their heart is letting them realise you recognise it. Do it sincerely — importance bought with obvious flattery backfires instantly.', a: 'Name aloud one way the person in front of you is genuinely better than you at something, and mean it.' },
      { t: 'The only way to get the best of an argument is to avoid it', e: 'Nine times out of ten, an argument ends with both sides more convinced they were right. You may win the logic and lose the goodwill — and goodwill is the only currency that buys lasting influence. Welcome disagreement; distrust your first reaction; listen first.', a: 'Next time disagreement flares, say: let us think this over. Then find the one point where the other person is right and say so first.' },
      { t: 'Show respect for opinions; never say you are wrong', e: 'Telling someone they are wrong is a direct blow at their intelligence and pride — it never persuades, it only recruits them to the enemy. Begin instead with: I may be wrong; I frequently am — let us examine the facts.', a: 'Replace every you are wrong this week with I see it differently, and here is my thinking. Track what happens to the temperature.' },
      { t: 'Admit your own mistakes quickly and emphatically', e: 'Self-criticism disarms: when you say everything the other person was going to say against you, there is nothing left for them to do but magnanimously defend you. Fighting for a mistake guarantees it; confessing it often shrinks it.', a: 'Own one real mistake to one real person this week — fully, without the word but — and watch the relationship change.' },
      { t: 'Let the other person feel the idea is theirs', e: 'People support what they help create. The wise who wish to lead plant the seed, offer the frame, and let others furnish the details — suggestions beat orders, questions beat declarations, and credit freely given returns multiplied.', a: 'In your next group decision, present your idea as a question and let the group finish it. Then implement their version publicly.' },
    ],
    quotes: [
      'You can make more friends in two months by becoming interested in other people than in two years by trying to get people interested in you.',
      'Any fool can criticize, condemn and complain — and most fools do.',
      'Be hearty in your approbation and lavish in your praise.',
      'The person who seeks all the applause of others has put his happiness in their pockets.',
    ],
    plan: [
      'Day 1: No criticism, no complaints — a full day of catching yourself mid-sentence.',
      'Day 2: Give three specific, sincere appreciations to three different people.',
      'Day 3: Hold one conversation where you ask all the questions and use their name twice.',
      'Day 4: Admit one mistake quickly and emphatically, with no but attached.',
      'Day 5: In a disagreement, find and state the point where the other person is right.',
      'Day 6: Make someone feel important — name a genuine way they outclass you.',
      'Day 7: Plant an idea as a question and let someone else complete it; give them the credit.',
    ],
    who: 'Anyone whose career or life runs through other people — which is everyone; especially technical people whose skill has outgrown their ability to be liked and followed.',
  },
  {
    id: 'seven-habits',
    title: 'The 7 Habits of Highly Effective People',
    author: 'Stephen R. Covey',
    year: 1989,
    oneLine: 'Effectiveness is built on character, not personality techniques: move from dependence to independence to interdependence by installing seven principles as habits.',
    why: 'Covey studied two centuries of American success literature and found a suspicious split: everything before World War I taught character (integrity, courage, justice, patience); everything after taught personality — image, techniques, quick fixes. He called the modern version the personality ethic and argued it can only produce short-term wins. The book became a global phenomenon (over forty million copies) because it dared to say the hard thing: there are no shortcuts, only principles and the patience to live them.',
    coreIdea: 'Real effectiveness follows a natural progression Covey calls the maturity continuum: first you move from dependence (you take care of me) to independence (I take care of me) through three private-victory habits — be proactive, begin with the end in mind, put first things first. Then you move from independence to interdependence (we can do something better together) through three public-victory habits — think win-win, seek first to understand then to be understood, and synergize. The seventh habit, sharpen the saw, renews the asset that does all the work: you. Underneath the habits sit the operating principles. See things as they are — paradigms — because each of us sees the world not as it is but as we are; fundamental change requires a paradigm shift, not better techniques on a wrong map. Balance production with production capability (P/PC balance): Aesop\'s goose that laid golden eggs teaches that results (P) matter less than the asset that produces them (PC). And every relationship runs on an emotional bank account — deposits of keeping promises, small kindnesses, loyalty to the absent and sincere apologies build trust; withdrawals of broken trust bankrupt it no matter how charming you are. Effectiveness, Covey insists, is not efficiency at everything — it is doing the few vital things well while refusing the many trivial ones.',
    lessons: [
      { t: 'Be proactive: you are the programmer', e: 'Between stimulus and response lies your freedom to choose. Reactive people are driven by weather, moods and other people\'s behaviour; proactive people act from values, and focus their energy inside their circle of influence rather than complaining inside their circle of concern.', a: 'For one full day, replace every I have to with I choose to — and notice which tasks reveal themselves as choices you keep making.' },
      { t: 'Begin with the end in mind', e: 'All things are created twice: first in the mind, then in reality. Without a personal vision you default to other people\'s scripts — family, peers, media. Covey\'s sharpest tool: imagine your own funeral and hear what your family, friends and colleagues say about you; then live backward from that.', a: 'Write a one-page personal mission statement this week: your roles, and what you want said about you in each at the end.' },
      { t: 'Put first things first', e: 'Habits one and two decide what matters; habit three is the daily discipline of doing it. Covey\'s matrix sorts everything by urgency and importance — effective people live in quadrant two (important, not urgent): planning, relationships, prevention, renewal — and refuse quadrant three\'s illusion that urgent means important.', a: 'Each Sunday, schedule the big rocks first: three important-not-urgent items get calendar slots before anything else is placed.' },
      { t: 'Think win-win or no deal', e: 'Six paradigms of human interaction exist (win-lose, lose-win, lose-lose and others); only win-win works durably in interdependent relationships, because anything else poisons the emotional bank account. Where win-win is impossible, the disciplined answer is win-win or no deal — no agreement is better than a bad one.', a: 'Before your next negotiation, write what a genuinely good outcome for the other side looks like — then engineer it into your proposal.' },
      { t: 'Seek first to understand, then to be understood', e: 'Most people listen with intent to reply, not to understand — they diagnose before they hear the case. Empathic listening (inside the other person\'s frame, until they feel felt) deposits enormously in the emotional bank account, and only after that is your own presentation credible. Diagnose before you prescribe.', a: 'In your next disagreement, restate the other person\'s position until they say yes, that is exactly it — before presenting yours.' },
      { t: 'Synergize: the third alternative', e: 'Synergy means the whole exceeds the sum of parts — 1 plus 1 equals 3 or 300. It is not compromise (1 plus 1 equals 1.5, everyone loses half); it is valuing differences enough to search for a third alternative better than either original position. Uniformity is not unity.', a: 'Next time two options deadlock a group, refuse the vote and ask: what would a third way look like that is better than both? Timebox the search to 20 minutes.' },
      { t: 'Sharpen the saw: renew the asset', e: 'You are the instrument of everything else — a dull saw makes every cut harder. Renewal has four dimensions: physical (exercise, nutrition, rest), mental (reading, writing, learning), social-emotional (service, empathy, synergy) and spiritual (values, meditation, nature). Neglect any one and the others degrade.', a: 'Block one hour this week per dimension — four hours total — and treat them as non-negotiable appointments with the asset that is you.' },
      { t: 'Inside-out: private victory before public victory', e: 'Trying to fix relationships before character is like hacking at leaves when the problem is the root. Trust flows from trustworthiness; no technique survives contact with an untrustworthy person for long. Work on yourself first — the outside results follow the inside condition.', a: 'Name the one character flaw (impatience, dishonesty, ego) that most damages your relationships — and make it this quarter\'s private project.' },
      { t: 'The emotional bank account', e: 'Every relationship carries a balance of trust. Deposits: understanding the individual, keeping promises, small courtesies, clarifying expectations, personal integrity, apologising sincerely. Withdrawals: broken promises, ambiguity, contempt, duplicity. High balance permits blunt, fast communication; low balance makes every sentence a minefield.', a: 'Make three specific deposits this week into your most important relationship — a kept promise, a sincere apology, an act of loyalty to someone absent.' },
      { t: 'P/PC balance: golden eggs and the goose', e: 'Effectiveness lies in the balance: P (production of desired results) and PC (production capability — the asset that produces them). A mower owner who never services it loses both grass and machine; a parent who buys compliance with gifts loses the relationship. Overproducing without renewal kills the goose.', a: 'For your most valuable output (your job, your health, your marriage), write the one renewal activity you keep skipping — and schedule it first, not last.' },
    ],
    quotes: [
      'Between stimulus and response there is a space; in that space lies our freedom to choose.',
      'The main thing is to keep the main thing the main thing.',
      'Most people do not listen with the intent to understand; they listen with the intent to reply.',
      'Sow a thought, reap an action; sow an action, reap a habit; sow a habit, reap a character; sow a character, reap a destiny.',
    ],
    plan: [
      'Day 1: Circle of influence audit — list your top five frustrations, mark each as influence or concern, act only on influence.',
      'Day 2: Draft your personal mission statement: roles first, then the legacy line for each role.',
      'Day 3: Quadrant two day — schedule three important-not-urgent tasks and protect their slots.',
      'Day 4: Empathic listening drill — one conversation where you restate their position before stating yours.',
      'Day 5: One win-win proposal — write the other side\'s ideal outcome into your next ask.',
      'Day 6: Three deposits into your most important emotional bank account.',
      'Day 7: Sharpen the saw — one hour across physical, mental, social and spiritual renewal, and plan next week\'s four hours.',
    ],
    who: 'Anyone competent but unbalanced — achieving in one role while bankrupting another — who wants a principle-centred operating system for the whole life, not a productivity hack.',
  },
  {
    id: 'atomic-habits',
    title: 'Atomic Habits',
    author: 'James Clear',
    year: 2018,
    oneLine: 'Tiny changes, remarkable results: habits compound like interest, systems beat goals, and every habit is built by making the cue obvious, the craving attractive, the response easy and the reward satisfying.',
    why: 'Clear spent years recovering from a serious injury and rebuilding his life through small routines, then spent a decade studying habit science and publishing practical essays read by millions. The book became a multi-year bestseller because it took the lab findings — cue, craving, response, reward — and turned them into an operating manual with no mysticism: not how to be inspired, but how to build the machine that runs without inspiration.',
    coreIdea: 'Habits are the compound interest of self-improvement: getting one percent better every day counts for little on any single day and everything over a year — the same maths that makes money multiply makes mastery multiply, and the same maths lets small daily errors compound into disaster. Results lag behind efforts, which creates a valley of disappointment where most people quit: your work is not wasted, it is stored — like an ice cube that needs many degrees of heating before it melts at zero. Goals are about results you want; systems are about processes that lead to results — winners and losers share the same goals, so goals cannot be the differentiator; the system is. And the deepest layer: habits shape identity. Every action is a vote for the type of person you wish to become — you do not need a unanimous vote, just a majority — so the practical path is not outcome-based (I want to run a marathon) but identity-based (I am a runner; runners run). The mechanism is the four-step habit loop — cue, craving, response, reward — and the four laws that follow: to build a habit make the cue obvious (design the environment, stack the habit onto an existing one), make it attractive (pair it with something you want, join a group where the behaviour is normal), make it easy (reduce friction, start with a two-minute version), and make it satisfying (immediate reinforcement, habit tracking, never miss twice). To break a bad habit, invert each law: make it invisible, unattractive, difficult and unsatisfying.',
    lessons: [
      { t: 'The one percent rule: habits compound', e: 'Improving by one percent daily leaves you thirty-seven times better after a year; declining one percent daily leaves you near zero. Habits are invisible now and undeniable later — which is exactly why they are ignored until they explode.', a: 'Pick one keystone area and define its one-percent version today: ten push-ups, one page, ten minutes of the skill. Log day one.' },
      { t: 'Forget goals, build systems', e: 'Goals set direction but systems make progress; winners and losers share identical goals, so the goal never made the difference. Goals also have hidden costs: they restrict happiness to the finish line and they collide with long-term progress.', a: 'Rewrite your biggest goal as a system: the weekly schedule of actions that would make the goal inevitable. Follow the schedule, not the scoreboard.' },
      { t: 'Identity-based habits: become the person', e: 'Behaviour change has three layers: outcomes (what you get), processes (what you do) and identity (what you believe). Lasting change works inside-out: each repetition is a vote for the identity, and evidence — not affirmations — is what convinces the mind.', a: 'Finish this sentence and post it where you will see it: I am the type of person who ____. Then collect two votes for it this week.' },
      { t: 'The habit loop: cue, craving, response, reward', e: 'Every habit runs the same four-step neurological loop. The cue triggers the brain, the craving supplies the motivation, the response is the behaviour, the reward satisfies and teaches the loop to run again. Change any step and the whole habit changes.', a: 'Map one of your worst habits through the loop: exact cue, the craving underneath, the response, what reward it buys. Name each aloud.' },
      { t: 'Law 1: make it obvious (and stack it)', e: 'Until a habit becomes automatic you must notice the cues. The most reliable upgrade is implementation: after [current habit], I will [new habit] — the existing behaviour becomes the cue for the new one, needing no memory or willpower.', a: 'Write two habit stacks today anchored to things you already do without fail (after I pour tea...; after I sit at my desk...).' },
      { t: 'Law 1b: design your environment', e: 'Motivation is overrated; environment usually matters more. Small changes in context change behaviour dramatically — put the guitar in the middle of the room, the fruit on the counter, the phone in another room. Be the architect of your space, not its victim.', a: 'Redesign one surface today (desk, nightstand, kitchen counter) so the good habit\'s cue is visible and the bad habit\'s cue is gone.' },
      { t: 'Law 2: make it attractive', e: 'The more attractive an opportunity, the more habitual it becomes — dopamine drives pursuit, not just pleasure. Temptation bundling pairs an action you want with an action you need; and because we imitate the close, the many and the powerful, join a group where your desired behaviour is normal.', a: 'Build one temptation bundle this week: only while doing [needed habit] may I enjoy [wanted thing].' },
      { t: 'Law 3: make it easy — the two-minute rule', e: 'Human behaviour follows the law of least effort; friction decides everything. Scale any new habit down to a two-minute version — read one page, put on the shoes — because the point is to master showing up before optimising the work. A habit must be established before it can be improved.', a: 'Shrink your hardest new habit to under two minutes and do that version today. Standardise before you optimise.' },
      { t: 'Law 4: make it satisfying (and track it)', e: 'What is immediately rewarded is repeated; what is immediately punished is avoided — and modern good habits pay off late, which is why they die. Add a small immediate reward, and use a habit tracker: the visual chain becomes its own craving, and marking the X is satisfying in itself.', a: 'Start a tracker today — a calendar with one X per completed rep. Your only rule: do not break the chain.' },
      { t: 'Never miss twice', e: 'Missing once is an accident; missing twice is the beginning of a new habit. Perfection is not required — consistency is. On bad days, do the tiny version badly rather than not at all; a rep still casts a vote for the identity.', a: 'Write your never-miss-twice contract for one habit, including the bad-day minimum version of it. Sign and date it.' },
      { t: 'Break bad habits by inverting the laws', e: 'Make the cue invisible (remove it from the environment), make it unattractive (reframe the benefits you have been feeding it), make it difficult (add friction — distance, steps, time delays), and make it unsatisfying (an accountability partner, a contract with a real cost).', a: 'Take your worst habit and add twenty seconds of friction to its cue today — put the remote in another room, log the app out, move the snacks up a shelf.' },
      { t: 'The Goldilocks rule and staying engaged', e: 'Peak motivation lives right at the edge of your current ability — roughly four percent beyond it. Too easy bores, too hard overwhelms; the greatest threat to established habits is not failure but boredom, and professionals simply show up while amateurs wait to feel inspired.', a: 'Adjust one practice this week to sit just past your comfort edge — slightly harder reps, slightly longer sessions — and schedule it when you are freshest.' },
    ],
    quotes: [
      'You do not rise to the level of your goals; you fall to the level of your systems.',
      'Every action you take is a vote for the type of person you wish to become.',
      'Success is the product of daily habits, not once-in-a-lifetime transformations.',
      'Professionals stick to the schedule; amateurs let life get in the way.',
    ],
    plan: [
      'Day 1: List your current habits and mark each with a plus, minus or equals — awareness first.',
      'Day 2: Choose one identity statement (I am a...) and one keystone habit that votes for it.',
      'Day 3: Shrink it to the two-minute version and write two habit stacks anchoring it.',
      'Day 4: Redesign one environment surface so the cue is obvious and competing cues vanish.',
      'Day 5: Build a temptation bundle and start the habit tracker — mark your first X.',
      'Day 6: Add friction to your worst habit — twenty extra seconds between you and it.',
      'Day 7: Review the week: votes cast, chain length, and next week\'s one-percent adjustment.',
    ],
    who: 'Everyone who has started strong and faded by week three — the operating manual for people who are done relying on motivation.',
  },
  {
    id: 'zero-to-one',
    title: 'Zero to One',
    author: 'Peter Thiel (with Blake Masters)',
    year: 2014,
    oneLine: 'Progress comes from creating new things (0 to 1), not copying what works (1 to n); the durable fortunes belong to monopolies built on secrets, not to competitors in crowded markets.',
    why: 'Written from the Stanford course Thiel taught with Blake Masters, Zero to One is the contrarian counterweight to every follow-the-market playbook. Thiel — PayPal founder, first outside investor in Facebook — argues the next Bill Gates will not build an operating system and the next Larry Page will not build a search engine: copying the greats teaches you nothing new. For anyone serious about the billionaire question, this is the book that explains why employment and competition rarely produce fortunes — ownership of something genuinely new does.',
    coreIdea: 'Every moment in business happens once: the next big thing will not look like the last big thing, so the central question of any venture is contrarian — what important truth do very few people agree with you on? Progress takes two forms: horizontal (1 to n — globalising what works, copying) and vertical (0 to 1 — doing what has never been done, technology in the broad sense). Globalisation without new technology is unsustainable; only 0-to-1 creation expands what is possible. Thiel\'s most provocative claim: competition is for losers. Perfect competition leaves no profit for anyone — restaurants mutually destroy their margins while smiling about the hustle — whereas a creative monopoly (Google in search) earns so durably that it can treat its workers, customers and future generously. Monopoly is the condition of every successful business; the rest is a struggle over scraps. Monopolies last by owning a niche completely first (PayPal started with eBay power-sellers; Facebook with one campus) and expanding outward, protected by proprietary technology at least ten times better, network effects, economies of scale and branding. Founding matters enormously — Thiel\'s law: a startup messed up at its foundation cannot be fixed — so choose co-founders whose working relationship you have tested, align ownership so everyone holds equity (cash incentives encourage short-term extraction; equity encourages building), and keep the board small and the team tight. Sales and distribution are not secondary to the product — they are the product\'s oxygen; nerds underestimate them because good sales looks invisible. And the future is not a fog of probabilities: definite optimists plan and build a concrete better future; indefinite optimists diversify portfolios and hope. The power law governs everything — one investment, one skill, one market, one decision can outweigh all others combined — so concentrate ruthlessly on the few things that can matter exponentially.',
    lessons: [
      { t: 'Zero to one beats one to n', e: 'Copying what works takes the world from 1 to n — familiar, incremental, and eventually a race to the bottom. Creating something new takes it from 0 to 1, and that single act is where all durable value — and all outsized fortunes — originate.', a: 'Write down what you currently build or do. Label it honestly: 0-to-1 or 1-to-n? Then name one way to add a genuinely new element this quarter.' },
      { t: 'Answer the contrarian question', e: 'What important truth do very few people agree with you on? Brilliant companies are built on contrarian truths that turn out right — secrets hiding in plain sight where convention says nothing exists.', a: 'Write three beliefs you hold that your smart peers would dispute. For each, ask: if this is true, what valuable thing could I build that no one else sees?' },
      { t: 'Competition is for losers', e: 'Capitalism and competition are opposites: competition homogenises and destroys margins (everyone opens a restaurant; nobody profits), while creation earns monopoly rents. The war mentality also blinds you to what actually matters — the customer and the future.', a: 'List where you are competing hardest today. For each, ask: am I fighting because it is valuable, or because there is someone to fight?' },
      { t: 'Creative monopolies drive progress', e: 'A monopoly that earns by creating something vastly better (not by cornering a market through force) can afford to care about employees, customers and long-term research. Google\'s dominance in search funds everything else it builds — profit from creation is what makes generosity sustainable.', a: 'If you run or plan a business, define the one capability you could make ten times better than any alternative — that gap is the monopoly seed.' },
      { t: 'Last mover advantage', e: 'Forget first-mover advantage: what matters is making the last great development in a field and enjoying years of monopoly cash flow. The value of a business is the sum of all future cash — so build to still be dominant a decade out, not to make news this month.', a: 'Sketch your venture\'s year-ten picture: what must be true for it to still hold its niche? Work backwards to this quarter\'s priorities.' },
      { t: 'Start with a small niche and own it', e: 'Every great company began by monopolising a tiny market — PayPal with eBay power-sellers, Facebook with Harvard — then expanded in concentric circles. A big share of a small market teaches, funds and brands you; a small share of a big market starves you.', a: 'Shrink your target: name the smallest group of people you could serve completely and dominate within twelve months. Rewrite your plan around them.' },
      { t: 'Foundations cannot be fixed later', e: 'Thiel\'s law: a startup messed up at its foundation cannot be fixed. Co-founder alignment (technical and personal), clean equity splits, a small board, and full-time commitment decide outcomes before the product exists. Bad early structure dooms later brilliance.', a: 'If you have partners, write the uncomfortable questions now: who decides what, what happens on disagreement, who owns what. Agree in writing before money arrives.' },
      { t: 'Pay people in equity, not cash', e: 'High cash salaries encourage people to extract value; equity aligns everyone to create it — because equity is only worth anything if the future is worth building. The best hires bet on the mission; anyone who needs convincing with salary probably should not join.', a: 'If you hire or partner this year, structure compensation around ownership of the outcome — and be able to explain the mission in two sentences.' },
      { t: 'Sales and distribution are everything', e: 'Superior product is not enough — if you have not built an effective way to sell it, you have no business, however good the product. Every distribution channel has a price and a reach; even viral products are engineered, and even the best sales looks like no sales at all.', a: 'Answer in writing: how will exactly ten customers find you? Name the channel, the cost per customer and the first experiment — this week.' },
      { t: 'Technology should complement humans', e: 'The most valuable businesses of coming decades will be built by entrepreneurs who use machines as complements, not substitutes — tools that let people do new things, not automation that replaces them and captures savings for competitors.', a: 'In your work, identify one repetitive task a machine could absorb — and one uniquely human task that absorbing it would free you to do better.' },
      { t: 'Definite optimism: plan the future', e: 'Indefinite optimists treat the future as a fog of probabilities and diversify; definite optimists have a concrete plan they execute against. A world run by indefinite people drifts; every great creation — from the Manhattan Project to the iPhone — was definite.' , a: 'Write your five-year definite plan on one page: the future you will have built, and the two or three bets that build it. Review monthly.' },
      { t: 'The power law: concentrate, do not diversify', e: 'Outcomes follow a power law, not a bell curve — one company in a portfolio, one skill in a career, one market in a plan can outproduce everything else combined. Diversification is a hedge against not knowing what you are doing; knowing is rare and worth concentrating on.', a: 'Rank your current projects and commitments by potential impact. Cut or delegate the bottom half so the top one gets your best hours.' },
    ],
    quotes: [
      'The most contrarian thing of all is not to oppose the crowd but to think for yourself.',
      'Competition is for losers — what makes a business valuable is the ability to do something no one else can.',
      'All happy companies are different: each one earns a monopoly by solving a unique problem.',
      'A startup is the largest group of people you can convince of a plan to build a different future.',
    ],
    plan: [
      'Day 1: Answer the contrarian question in writing — three truths few around you accept.',
      'Day 2: Define the smallest niche you could fully dominate within a year; describe its members precisely.',
      'Day 3: State your ten-times-better claim: what could you build that is an order of magnitude better than alternatives?',
      'Day 4: Map the foundation — decisions, ownership, roles — and write the agreement you would hate to renegotiate later.',
      'Day 5: Design distribution: name the channel, the first ten customers, and the experiment that proves it.',
      'Day 6: Apply the power law — list commitments, rank by impact, and cut the bottom half from your best hours.',
      'Day 7: Write your definite five-year plan on one page and schedule its monthly review.',
    ],
    who: 'Ambitious builders and career-owners who are done competing for scraps — the strategy layer of the billionaire path: ownership of something genuinely new, planned definitely.',
  },
];

// ---------------------------------------------------------------------------
// aliases + lookup
// ---------------------------------------------------------------------------

export const BOOK_ALIASES = {
  'think and grow rich': 'think-and-grow-rich',
  'think & grow rich': 'think-and-grow-rich',
  'think grow rich': 'think-and-grow-rich',
  'napoleon hill': 'think-and-grow-rich',
  'hill book': 'think-and-grow-rich',
  'rich dad poor dad': 'rich-dad-poor-dad',
  'rich dad': 'rich-dad-poor-dad',
  'poor dad': 'rich-dad-poor-dad',
  'kiyosaki': 'rich-dad-poor-dad',
  'assets and liabilities': 'rich-dad-poor-dad',
  'how to win friends': 'how-to-win-friends',
  'how to win friends and influence people': 'how-to-win-friends',
  'win friends': 'how-to-win-friends',
  'win friends influence people': 'how-to-win-friends',
  'carnegie': 'how-to-win-friends',
  'dale carnegie': 'how-to-win-friends',
  '7 habits': 'seven-habits',
  'seven habits': 'seven-habits',
  '7 habits of highly effective people': 'seven-habits',
  'seven habits of highly effective people': 'seven-habits',
  'highly effective people': 'seven-habits',
  'covey': 'seven-habits',
  'stephen covey': 'seven-habits',
  'atomic habits': 'atomic-habits',
  'atomic habit': 'atomic-habits',
  'james clear': 'atomic-habits',
  'tiny changes remarkable results': 'atomic-habits',
  'zero to one': 'zero-to-one',
  '0 to 1': 'zero-to-one',
  'zero2one': 'zero-to-one',
  'peter thiel': 'zero-to-one',
  'thiel': 'zero-to-one',
};

export const READING_PATHS = {
  default: ['think-and-grow-rich', 'rich-dad-poor-dad', 'how-to-win-friends',
            'seven-habits', 'atomic-habits', 'zero-to-one'],
  billionaire: ['think-and-grow-rich', 'rich-dad-poor-dad', 'zero-to-one',
                'atomic-habits', 'how-to-win-friends', 'seven-habits'],
  habits: ['atomic-habits', 'seven-habits', 'think-and-grow-rich',
           'how-to-win-friends', 'rich-dad-poor-dad'],
  people: ['how-to-win-friends', 'seven-habits', 'think-and-grow-rich',
           'atomic-habits', 'rich-dad-poor-dad'],
  money: ['rich-dad-poor-dad', 'zero-to-one', 'think-and-grow-rich',
          'seven-habits', 'atomic-habits'],
};

/**
 * Find a shelf book from free text. Matching is on contiguous phrases only —
 * "my dad is poor" must never resolve to Rich Dad Poor Dad (the personal
 * guard in understand.js plus phrase matching keep memories and books apart).
 * @returns {object|null} the book object, or null
 */
export function findBook(query) {
  const q = String(query || '').toLowerCase();
  if (!q.trim()) return null;
  const byId = new Map(SUCCESS_BOOKS.map((b) => [b.id, b]));
  // longest alias first so "7 habits of highly effective people" beats "7 habits"
  const aliases = Object.keys(BOOK_ALIASES).sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    if (alias.length >= 4 && q.includes(alias)) return byId.get(BOOK_ALIASES[alias]) || null;
  }
  // fall back to title match
  for (const book of SUCCESS_BOOKS) {
    if (book.title.length >= 4 && q.includes(book.title.toLowerCase())) return book;
  }
  return null;
}

export function bookCount() {
  return SUCCESS_BOOKS.length;
}
