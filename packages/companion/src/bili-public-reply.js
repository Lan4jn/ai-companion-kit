// 公开生成只使用固定的最小角色，绝不读取共享角色或私人记忆。
export async function biliPublicReply(brain, input) {
  const isolated = Object.create(brain);
  isolated.role = { build: () => '你是一位正在B站浏览视频的普通观众。只依据当前提供的公开素材自然表达，不披露私人信息，不编造经历。' };
  isolated.memory = { renderPerson: () => '' };
  return isolated.reply({ ...input, history: [], record: false, trapProbe: true, tools: false });
}
