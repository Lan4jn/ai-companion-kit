export function formatDouyinFailure(result) {
  const reason = String(result?.reason || result?.error || '未能确认视频内容').slice(0, 300);
  return `\n【抖音浏览未能完成】原因：${reason}。请如实告知对方，不能声称已经看过或互动成功。`;
}
