// Conservative, best-effort guard for public comments; it cannot detect every
// private fact or obfuscation. On uncertain types or malformed input, block.
export function isDouyinPublicTextSafe(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 500) return false;
  const s = text.normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '');
  const joined = s.replace(/(?<=\d)[\s\p{P}\p{S}]+(?=\d)/gu, '');
  return !(/\d{7,}/.test(joined) || /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(s) || /私聊|聊天记录|私人日记|日记里|密码|验证码|身份证|银行卡|手机号|电话号码|微信号|住址|家庭地址|(?:省|市|区|县).{0,20}(?:小区|街道|街|路|号|栋|室)/.test(s));
}
