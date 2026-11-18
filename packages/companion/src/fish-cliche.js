// Only reject an entire, unquoted empty formula. Never remove substrings:
// surrounding words may carry facts, conditions, or a different stance.
export function hasFishCliche(value) {
  const s = String(value ?? '').trim();
  if (/^(?:(?:这条我认|这话我认|这句我认|我记下了|这话我记下了|我接住了|接住了)[。！!？?]*|(?:这句我记下了|这句接住了|这话接住了|这句我接住了|这话我接住了)[。！!]*)$/u.test(s)) return true;

  // Match only whole replies built from these empty meta-commentary and
  // theatrical surrender clauses. Requiring both prevents blocking a real
  // game result, apology, explanation, quotation, or factual correction.
  const separator = '[\\s，,。！!；;、]+';
  const meta = '(?:那句|这句|那话|这话)(?:确实|真|的确)?(?:不太|不怎么|不像|不|有点)?(?:像我说的|是我说的|像我|是我的风格)';
  const mechanical = '(?:一绕就被你绕出|被你绕出|又说出|又冒出|又有了|说得像|说出了|变成了)(?:机器腔|机器人味|机器味|AI味|机械腔)了?';
  const filler = '(?:行|好|得|算了|好吧|行吧|得了|我认|我认了|我服|我服了|我输了|认输)';
  const surrender = '(?:这局|这回|这次)(?:算)?(?:你赢|我输)(?:了)?';
  const combination = new RegExp(`^(?:${meta}${separator})?${mechanical}${separator}(?:${filler}${separator})+${surrender}[。！!]*$`, 'u');
  return combination.test(s);
}
