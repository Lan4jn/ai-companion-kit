/**
 * 虚拟居室角色模型 (Room Character Model)
 *
 * 纯状态映射、动画优先级、clip fallback、以及锚点定位与尺寸计算。
 * 纯逻辑模块，可同时在 Node.js (测试环境) 与浏览器中运行。
 */

/**
 * 居室业务状态到动作与世界坐标的映射表
 * 房间基准分辨率为 1536 x 1024
 */
export const ROOM_STATES = {
  bed_phone: {
    clip: 'idle',
    position: [680, 690],
    description: '在床边看手机',
  },
  bed_sit: {
    clip: 'idle',
    position: [560, 640],
    description: '在床沿端坐休息',
  },
  bed_sleep: {
    clip: 'sleep',
    position: [510, 620],
    description: '在床沿小憩沉眠',
  },
  crawling: {
    clip: 'move',
    position: [1080, 690],
    description: '费劲爬向书桌',
  },
  desk_laptop: {
    clip: 'work',
    position: [1080, 680],
    description: '在书桌前敲代码写笔记',
  },
};

export const DEFAULT_ROOM_STATE = 'bed_phone';
export const BASE_WORLD_WIDTH = 1536;
export const BASE_WORLD_HEIGHT = 1024;
export const DEFAULT_RENDER_WIDTH = 480;

/**
 * 将业务状态解析为 clip 与目标世界坐标
 * 使用 Object.hasOwn 严格防御原型链属性注入（如 constructor、__proto__、toString 等）
 * @param {string} stateName - 居室状态名称
 * @returns {{ state: string, clip: string, position: [number, number], description: string, isFallback?: boolean }}
 */
export function resolveStateMapping(stateName) {
  if (stateName && typeof stateName === 'string' && Object.hasOwn(ROOM_STATES, stateName)) {
    return {
      state: stateName,
      ...ROOM_STATES[stateName],
    };
  }
  // 未知或非法状态安全回退至 bed_phone (idle)
  const fallback = ROOM_STATES[DEFAULT_ROOM_STATE];
  return {
    state: typeof stateName === 'string' && stateName ? stateName : DEFAULT_ROOM_STATE,
    clip: fallback.clip,
    position: [...fallback.position],
    description: fallback.description,
    isFallback: true,
  };
}

/**
 * 相对 URL 拼装辅助函数
 * @param {string} base - 基础 URL 前缀
 * @param {string} relative - 相对路径
 * @returns {string}
 */
export function resolveUrl(base, relative) {
  if (!relative) return '';
  if (/^https?:\/\//i.test(relative) || relative.startsWith('/')) {
    return relative;
  }
  const cleanBase = base ? (base.endsWith('/') ? base : `${base}/`) : '';
  return `${cleanBase}${relative}`;
}

/**
 * 根据 Manifest 解析动作的完整元数据（含 URL 与循环标记）
 * @param {object} manifest - 角色 manifest.json 数据
 * @param {string} clipName - 动作名称 ('idle', 'move', 'sleep', 'work', 'think', 'greet')
 * @param {string} [baseUrl=''] - 资源基础路径
 * @returns {{ name: string, src: string, poster: string, loop: boolean }}
 */
export function resolveClip(manifest, clipName, baseUrl = '') {
  const clips = manifest?.clips || {};
  let targetName = clipName;
  let clipData = clips[targetName];

  // 若请求的 clip 不存在，回退到 idle
  if (!clipData) {
    targetName = 'idle';
    clipData = clips.idle || {
      src: 'clips/idle.webm',
      poster: 'clips/idle.webp',
      loop: true,
    };
  }

  return {
    name: targetName,
    src: resolveUrl(baseUrl, clipData.src),
    poster: resolveUrl(baseUrl, clipData.poster),
    loop: typeof clipData.loop === 'boolean' ? clipData.loop : true,
  };
}

/**
 * 计算脚底固定锚点与世界坐标系下的变换参数
 * @param {object} options
 * @param {number} options.worldX - 目标世界脚底 X
 * @param {number} options.worldY - 目标世界脚底 Y
 * @param {object} options.manifest - 角色 manifest 数据
 * @param {number} [options.renderWidth=480] - 角色完整画幅在世界坐标系下的基准宽度
 * @param {number} [options.stageWidth=1536] - 舞台当前实际像素宽度，用于计算缩放比
 * @returns {{ renderWidth: number, renderHeight: number, worldLeft: number, worldTop: number, translateXPercent: number, translateYPercent: number, anchorPercentX: number, anchorPercentY: number, scale: number }}
 */
export function calculateAnchorTransform({
  worldX,
  worldY,
  manifest,
  renderWidth = DEFAULT_RENDER_WIDTH,
  stageWidth = BASE_WORLD_WIDTH,
}) {
  const canvas = manifest?.canvas || [640, 360];
  const anchor = manifest?.anchor || [320, 330];

  const canvasWidth = canvas[0] || 640;
  const canvasHeight = canvas[1] || 360;
  const anchorX = anchor[0] || 320;
  const anchorY = anchor[1] || 330;

  const aspectRatio = canvasHeight / canvasWidth;
  const renderHeight = renderWidth * aspectRatio;

  const anchorRatioX = anchorX / canvasWidth;
  const anchorRatioY = anchorY / canvasHeight;

  // 锚点相对于自身左上角的像素偏移
  const anchorPixelX = anchorRatioX * renderWidth;
  const anchorPixelY = anchorRatioY * renderHeight;

  // 使得自身锚点重合于 (worldX, worldY)
  const worldLeft = worldX - anchorPixelX;
  const worldTop = worldY - anchorPixelY;

  // CSS transform translate 百分比是相对于元素自身的尺寸 (renderWidth, renderHeight)
  // 当元素宽度为 stageWidth * (renderWidth / 1536) 时：
  // translateX = (translateXPercent / 100) * (stageWidth * renderWidth / 1536)
  // 若要使得 translateX = stageWidth * (worldLeft / 1536)，必须满足：
  // translateXPercent = (worldLeft / renderWidth) * 100
  // 同理 translateYPercent = (worldTop / renderHeight) * 100
  const translateXPercent = (worldLeft / renderWidth) * 100;
  const translateYPercent = (worldTop / renderHeight) * 100;

  const scale = stageWidth / BASE_WORLD_WIDTH;

  return {
    renderWidth,
    renderHeight,
    worldLeft,
    worldTop,
    translateXPercent,
    translateYPercent,
    anchorPercentX: anchorRatioX * 100,
    anchorPercentY: anchorRatioY * 100,
    scale,
  };
}

/**
 * 根据 bodyBox 计算角色实体点击热区在完整画布中的相对百分比（仅供近似命中区域判定，非逐像素 alpha 判定）
 * @param {object} manifest - 角色 manifest
 * @returns {{ leftPercent: number, topPercent: number, widthPercent: number, heightPercent: number }}
 */
export function calculateHitTargetRect(manifest) {
  const canvas = manifest?.canvas || [640, 360];
  const bodyBox = manifest?.bodyBox || [212, 60, 428, 330];

  const canvasWidth = canvas[0] || 640;
  const canvasHeight = canvas[1] || 360;

  const [minX, minY, maxX, maxY] = bodyBox;

  return {
    leftPercent: (minX / canvasWidth) * 100,
    topPercent: (minY / canvasHeight) * 100,
    widthPercent: ((maxX - minX) / canvasWidth) * 100,
    heightPercent: ((maxY - minY) / canvasHeight) * 100,
  };
}

/**
 * 角色状态机：管理业务状态切换、短反馈、版本防竞态与动作优先级
 */
export class CharacterStateMachine {
  constructor({
    manifest,
    initialBusinessState = DEFAULT_ROOM_STATE,
    baseUrl = '',
  } = {}) {
    this.manifest = manifest;
    this.baseUrl = baseUrl;
    this.currentBusinessState = initialBusinessState;
    this.latestVersion = -1;
    this.latestTimestamp = 0;
    this._isGreeting = false;
  }

  getBusinessState() {
    return this.currentBusinessState;
  }

  isGreeting() {
    return this._isGreeting;
  }

  getCurrentClip() {
    if (this._isGreeting) {
      return resolveClip(this.manifest, 'greet', this.baseUrl);
    }
    const mapping = resolveStateMapping(this.currentBusinessState);
    return resolveClip(this.manifest, mapping.clip, this.baseUrl);
  }

  getCurrentPosition() {
    const mapping = resolveStateMapping(this.currentBusinessState);
    return mapping.position;
  }

  getCurrentDescription() {
    const mapping = resolveStateMapping(this.currentBusinessState);
    return mapping.description;
  }

  /**
   * 应用居室状态
   * 包含版本号与时序双重防竞争保护：优先检查 data.version（安全整数），再降级到 timestamp
   * @param {object} data - { state, version, updatedAt, action, message }
   * @returns {boolean} - 是否成功应用
   */
  applyRoomState(data = {}) {
    const { state, version, updatedAt = Date.now() } = data;

    const hasIncomingVersion = Number.isSafeInteger(version);
    const hasCurrentVersion = Number.isSafeInteger(this.latestVersion) && this.latestVersion >= 0;

    // 优先比较 version，再比较 timestamp
    if (hasIncomingVersion && hasCurrentVersion) {
      if (version < this.latestVersion) {
        return false;
      }
      if (version === this.latestVersion && updatedAt < this.latestTimestamp) {
        return false;
      }
    } else if (hasIncomingVersion && !hasCurrentVersion) {
      // 首次收到带版本的数据，接受
    } else if (!hasIncomingVersion && hasCurrentVersion) {
      // 当前已有合规版本记录，收到无版本数据时若时间戳较旧则拒绝
      if (updatedAt < this.latestTimestamp) {
        return false;
      }
    } else {
      // 双方均无版本号，按 timestamp 比较
      if (updatedAt < this.latestTimestamp) {
        return false;
      }
    }

    if (hasIncomingVersion) {
      this.latestVersion = version;
    }
    this.latestTimestamp = Math.max(this.latestTimestamp, updatedAt);

    if (state && typeof state === 'string') {
      this.currentBusinessState = state;
    }

    // 新状态可立即取消 greet 短反馈，优先响应业务状态
    if (this._isGreeting) {
      this._isGreeting = false;
    }
    return true;
  }

  /**
   * 触发一次 greet 互动反馈
   * 防连续点击堆积：若正在播放 greet，则忽略触发
   * @returns {boolean} - 是否成功触发
   */
  triggerGreet() {
    if (this._isGreeting) {
      return false;
    }
    this._isGreeting = true;
    return true;
  }

  /**
   * greet 播放结束时回调
   * 恢复当前业务状态对应的动作
   * @returns {{ name: string, src: string, poster: string, loop: boolean }}
   */
  onGreetEnded() {
    this._isGreeting = false;
    return this.getCurrentClip();
  }

  /**
   * 强制取消 greet
   */
  cancelGreet() {
    this._isGreeting = false;
  }
}
