export function stickerGuidance({seen,hasText}) {
 if(!seen)return '图片或表情包未识别，不猜画面或意图；看不清时可以坦诚说明，结合可见文字与上下文自然回应。';
 return hasText ? '结合上下文和对方文字自然回应，表情包可作为语气参考；除非对方询问，不必点评画面。' : '结合上下文与可见的表情自然回应，不必强行点评、接梗或抬杠；不确定就别猜。';
}
