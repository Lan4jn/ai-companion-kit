// Narrow public-comment gate: reject only a whole, unquoted, context-free
// acknowledgement. Do not ban words, punctuation, quotations or real details.
// A block means skip the comment, never rewrite or retry a publication.
export function isEmptyPublicFishCliche(value) {
  if (typeof value !== 'string') return false;
  const text = value.normalize('NFKC').trim().replace(/[。！!，,\s]+$/gu, '');
  return /^(?:这条我认|这话我认|这句我认|我接住了|接住了|这句接住了|这话我记下了|我记下了|我收下了)$/u.test(text);
}

export const PUBLIC_COMMENT_STYLE_GUIDANCE = '只在确有想说的话时评论，围绕当前公开素材中能核实的具体内容自然表达；素材不足或没话说就不评论。不要套用空洞的认领、接住、记下等自我旁白，也不要为了金句刻意对仗。正常叙述、引用和必要的对比不受限制。';
