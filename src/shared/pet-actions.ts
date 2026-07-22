/**
 * Model-independent desktop-pet action contract.
 *
 * Renderers map the semantic channels and motion templates below onto their own
 * skeleton, sprite sheet, Live2D parameters, or canvas drawing. No action names
 * a whale-specific body part, so a different pet model can reuse the catalogue.
 */

export const PET_ACTION_CATEGORIES = [
  'basic',
  'movement',
  'pointer',
  'emotion',
  'life',
  'function',
  'special',
  'transition',
  'internal',
] as const;

export type PetActionCategory = (typeof PET_ACTION_CATEGORIES)[number];

export const PET_ACTION_TRIGGER_KINDS = [
  'automatic',
  'idleTimer',
  'pointer',
  'drag',
  'command',
  'state',
  'schedule',
  'environment',
  'collision',
  'system',
  'transition',
  'internal',
] as const;

export type PetActionTriggerKind = (typeof PET_ACTION_TRIGGER_KINDS)[number];

export const PET_MODEL_CHANNELS = [
  'root',
  'body',
  'head',
  'eyes',
  'mouth',
  'appendages',
  'shadow',
  'prop',
  'fx',
] as const;

export type PetModelChannel = (typeof PET_MODEL_CHANNELS)[number];

export const PET_MOTION_TEMPLATES = [
  'holdPose',
  'idleBreath',
  'blink',
  'look',
  'stretch',
  'yawn',
  'walkCycle',
  'runCycle',
  'decelerate',
  'turn',
  'suspended',
  'dropBounce',
  'reaction',
  'sleepTransition',
  'sleepCycle',
  'wakeStretch',
  'fadeSlide',
  'jumpArc',
  'takeOff',
  'landSquash',
  'tumble',
  'recover',
  'sit',
  'stand',
  'lie',
  'slide',
  'edgeClimb',
  'edgeHold',
  'peek',
  'falling',
  'collisionPush',
  'pointerTracking',
  'shake',
  'petting',
  'poke',
  'chase',
  'reach',
  'perch',
  'push',
  'emote',
  'consume',
  'handoff',
  'refusal',
  'bathe',
  'groom',
  'propUse',
  'exercise',
  'illness',
  'transform',
  'attention',
  'thinking',
  'searching',
  'loading',
  'speaking',
  'writing',
  'timer',
  'focus',
  'alarm',
  'celebrate',
  'error',
  'disconnect',
  'weather',
  'idlePlay',
  'transition',
  'hidden',
] as const;

export type PetMotionTemplate = (typeof PET_MOTION_TEMPLATES)[number];
export type PetMotionIntensity = 'subtle' | 'medium' | 'strong';
export type PetMotionDirection =
  | 'none'
  | 'left'
  | 'right'
  | 'vertical'
  | 'pointer'
  | 'screenEdge'
  | 'bidirectional';

export const PET_VISUAL_CUES = [
  'pose',
  'blink',
  'gaze',
  'squashStretch',
  'motionLines',
  'dust',
  'sparkle',
  'heart',
  'angerMark',
  'tear',
  'sweat',
  'questionMark',
  'exclamationMark',
  'zzz',
  'bubble',
  'prop',
  'sign',
  'notification',
  'spinner',
  'confetti',
  'errorMark',
  'offlineBadge',
  'weather',
  'outfit',
  'soundWave',
  'impact',
  'fade',
  'shadow',
  'food',
  'water',
  'clean',
  'gift',
  'medicine',
  'timer',
  'screenEdge',
] as const;

export type PetVisualCue = (typeof PET_VISUAL_CUES)[number];

export interface PetActionDefinition<Id extends string = string> {
  readonly id: Id;
  readonly label: string;
  readonly category: PetActionCategory;
  /** One-shot duration, or one visual cycle for a looping action. */
  readonly durationMs: number;
  readonly loop: boolean;
  readonly trigger: { readonly kind: PetActionTriggerKind };
  readonly motion: {
    readonly template: PetMotionTemplate;
    readonly intensity: PetMotionIntensity;
    readonly direction: PetMotionDirection;
  };
  readonly visualCues: readonly PetVisualCue[];
  /** Semantic model slots; unsupported optional slots may be ignored. */
  readonly channels: readonly PetModelChannel[];
}

function action<const Id extends string>(
  id: Id,
  label: string,
  category: PetActionCategory,
  loop: boolean,
  durationMs: number,
  triggerKind: PetActionTriggerKind,
  template: PetMotionTemplate,
  visualCues: readonly PetVisualCue[],
  channels: readonly PetModelChannel[],
  intensity: PetMotionIntensity = 'medium',
  direction: PetMotionDirection = 'none',
): PetActionDefinition<Id> {
  return {
    id,
    label,
    category,
    loop,
    durationMs,
    trigger: { kind: triggerKind },
    motion: { template, intensity, direction },
    visualCues,
    channels,
  };
}

export const PET_ACTION_CATALOG = [
  // 基础动作
  action('idle', '待机循环', 'basic', true, 2400, 'automatic', 'holdPose', ['pose', 'shadow'], ['root', 'body', 'eyes', 'shadow'], 'subtle'),
  action('breathe', '呼吸', 'basic', true, 2200, 'automatic', 'idleBreath', ['squashStretch', 'shadow'], ['body', 'shadow'], 'subtle'),
  action('blink', '眨眼', 'basic', false, 240, 'idleTimer', 'blink', ['blink'], ['eyes'], 'subtle'),
  action('lookAround', '东张西望', 'basic', false, 2200, 'idleTimer', 'look', ['gaze'], ['head', 'eyes'], 'subtle', 'bidirectional'),
  action('stretch', '伸懒腰', 'basic', false, 1800, 'idleTimer', 'stretch', ['squashStretch', 'sparkle'], ['root', 'body', 'head', 'appendages'], 'medium', 'vertical'),
  action('yawn', '打哈欠', 'basic', false, 2100, 'idleTimer', 'yawn', ['bubble'], ['body', 'eyes', 'mouth'], 'subtle'),
  action('walkLeft', '向左走', 'basic', true, 720, 'command', 'walkCycle', ['motionLines', 'shadow'], ['root', 'body', 'appendages', 'shadow'], 'medium', 'left'),
  action('walkRight', '向右走', 'basic', true, 720, 'command', 'walkCycle', ['motionLines', 'shadow'], ['root', 'body', 'appendages', 'shadow'], 'medium', 'right'),
  action('stopWalking', '停止行走', 'basic', false, 420, 'command', 'decelerate', ['dust', 'squashStretch'], ['root', 'body', 'appendages', 'shadow'], 'subtle'),
  action('turnLeft', '转向左侧', 'basic', false, 480, 'command', 'turn', ['motionLines'], ['root', 'body', 'head', 'eyes'], 'medium', 'left'),
  action('turnRight', '转向右侧', 'basic', false, 480, 'command', 'turn', ['motionLines'], ['root', 'body', 'head', 'eyes'], 'medium', 'right'),
  action('dragged', '被拖拽悬空', 'basic', true, 560, 'drag', 'suspended', ['motionLines', 'shadow'], ['root', 'body', 'appendages', 'shadow'], 'medium', 'pointer'),
  action('drop', '放下并站稳', 'basic', false, 650, 'drag', 'dropBounce', ['impact', 'dust', 'squashStretch'], ['root', 'body', 'appendages', 'shadow'], 'medium', 'vertical'),
  action('clickFeedback', '点击反馈', 'basic', false, 900, 'pointer', 'reaction', ['gaze', 'sparkle', 'squashStretch'], ['body', 'head', 'eyes', 'mouth', 'fx'], 'medium', 'pointer'),
  action('sleepIn', '入睡', 'basic', false, 1200, 'state', 'sleepTransition', ['zzz'], ['root', 'body', 'eyes', 'mouth', 'fx'], 'subtle', 'vertical'),
  action('sleepLoop', '睡眠循环', 'basic', true, 2800, 'state', 'sleepCycle', ['zzz', 'bubble'], ['body', 'eyes', 'mouth', 'fx'], 'subtle'),
  action('wake', '醒来', 'basic', false, 1000, 'state', 'wakeStretch', ['sparkle', 'squashStretch'], ['root', 'body', 'head', 'eyes', 'appendages'], 'medium', 'vertical'),
  action('enter', '进入桌面', 'basic', false, 720, 'system', 'fadeSlide', ['fade', 'sparkle', 'shadow'], ['root', 'body', 'shadow', 'fx'], 'medium', 'vertical'),
  action('exit', '退出桌面', 'basic', false, 650, 'system', 'fadeSlide', ['fade', 'sparkle'], ['root', 'body', 'shadow', 'fx'], 'medium', 'vertical'),

  // 移动相关
  action('runLeft', '向左跑', 'movement', true, 420, 'command', 'runCycle', ['motionLines', 'dust'], ['root', 'body', 'appendages', 'shadow'], 'strong', 'left'),
  action('runRight', '向右跑', 'movement', true, 420, 'command', 'runCycle', ['motionLines', 'dust'], ['root', 'body', 'appendages', 'shadow'], 'strong', 'right'),
  action('jump', '跳跃', 'movement', false, 850, 'command', 'jumpArc', ['motionLines', 'shadow'], ['root', 'body', 'appendages', 'shadow'], 'strong', 'vertical'),
  action('takeOff', '起跳', 'movement', false, 260, 'command', 'takeOff', ['squashStretch', 'dust'], ['root', 'body', 'appendages', 'shadow'], 'strong', 'vertical'),
  action('land', '落地', 'movement', false, 420, 'collision', 'landSquash', ['impact', 'dust', 'squashStretch'], ['root', 'body', 'appendages', 'shadow'], 'strong', 'vertical'),
  action('fallDown', '摔倒', 'movement', false, 780, 'collision', 'tumble', ['impact', 'motionLines'], ['root', 'body', 'head', 'appendages', 'shadow'], 'strong', 'bidirectional'),
  action('recoverFromFall', '摔倒后爬起', 'movement', false, 1100, 'state', 'recover', ['sweat', 'squashStretch'], ['root', 'body', 'head', 'appendages', 'shadow'], 'medium', 'vertical'),
  action('sitDown', '坐下', 'movement', false, 650, 'command', 'sit', ['squashStretch', 'shadow'], ['root', 'body', 'appendages', 'shadow'], 'subtle', 'vertical'),
  action('standUp', '起身', 'movement', false, 650, 'command', 'stand', ['squashStretch', 'shadow'], ['root', 'body', 'appendages', 'shadow'], 'medium', 'vertical'),
  action('lieDown', '趴下', 'movement', false, 720, 'command', 'lie', ['squashStretch', 'shadow'], ['root', 'body', 'head', 'appendages', 'shadow'], 'subtle', 'vertical'),
  action('riseFromLie', '趴下后起身', 'movement', false, 760, 'command', 'stand', ['squashStretch', 'shadow'], ['root', 'body', 'head', 'appendages', 'shadow'], 'medium', 'vertical'),
  action('slide', '滑动', 'movement', false, 900, 'command', 'slide', ['motionLines', 'dust'], ['root', 'body', 'shadow'], 'strong', 'bidirectional'),
  action('climbScreenEdge', '沿屏幕边缘攀爬', 'movement', true, 920, 'collision', 'edgeClimb', ['screenEdge', 'motionLines'], ['root', 'body', 'appendages', 'shadow'], 'strong', 'screenEdge'),
  action('holdWindowEdge', '抓住窗口边缘', 'movement', true, 1200, 'collision', 'edgeHold', ['screenEdge', 'sweat'], ['root', 'body', 'head', 'appendages'], 'medium', 'screenEdge'),
  action('peekFromEdge', '从边缘探头', 'movement', true, 2100, 'idleTimer', 'peek', ['screenEdge', 'gaze'], ['root', 'body', 'head', 'eyes'], 'subtle', 'screenEdge'),
  action('fallFromHeight', '从高处掉落', 'movement', true, 700, 'collision', 'falling', ['motionLines', 'sweat'], ['root', 'body', 'appendages', 'shadow'], 'strong', 'vertical'),
  action('pushedByWindow', '被窗口推动或挤开', 'movement', false, 620, 'collision', 'collisionPush', ['impact', 'squashStretch'], ['root', 'body', 'head', 'appendages', 'shadow'], 'strong', 'bidirectional'),

  // 鼠标交互
  action('doubleClick', '双击反馈', 'pointer', false, 1200, 'pointer', 'reaction', ['sparkle', 'confetti', 'squashStretch'], ['root', 'body', 'head', 'eyes', 'mouth', 'fx'], 'strong', 'pointer'),
  action('rapidClickAnnoyed', '连续点击后的不耐烦反应', 'pointer', false, 1800, 'pointer', 'shake', ['angerMark', 'gaze'], ['body', 'head', 'eyes', 'mouth', 'fx'], 'strong', 'pointer'),
  action('hoverLookAtPointer', '悬停时看向光标', 'pointer', true, 900, 'pointer', 'pointerTracking', ['gaze'], ['head', 'eyes'], 'subtle', 'pointer'),
  action('trackPointerGaze', '跟随鼠标移动视线', 'pointer', true, 900, 'pointer', 'pointerTracking', ['gaze'], ['head', 'eyes'], 'subtle', 'pointer'),
  action('dragStruggle', '拖拽时挣扎或晃动', 'pointer', true, 480, 'drag', 'shake', ['motionLines', 'sweat'], ['root', 'body', 'head', 'appendages'], 'strong', 'pointer'),
  action('petHead', '抚摸头部', 'pointer', true, 1000, 'pointer', 'petting', ['heart', 'sparkle'], ['head', 'eyes', 'mouth', 'fx'], 'subtle', 'pointer'),
  action('pokeFace', '戳脸', 'pointer', false, 620, 'pointer', 'poke', ['impact', 'questionMark'], ['head', 'eyes', 'mouth', 'fx'], 'medium', 'pointer'),
  action('pokeBody', '戳身体', 'pointer', false, 620, 'pointer', 'poke', ['impact', 'squashStretch'], ['body', 'fx'], 'medium', 'pointer'),
  action('chasedByPointer', '被鼠标追赶', 'pointer', true, 520, 'pointer', 'chase', ['motionLines', 'sweat'], ['root', 'body', 'head', 'eyes', 'shadow'], 'strong', 'pointer'),
  action('catchPointer', '抓住鼠标指针', 'pointer', false, 900, 'pointer', 'reach', ['sparkle', 'impact'], ['root', 'body', 'head', 'eyes', 'appendages', 'fx'], 'strong', 'pointer'),
  action('sitOnPointer', '坐在鼠标指针上', 'pointer', true, 1500, 'pointer', 'perch', ['sparkle', 'shadow'], ['root', 'body', 'head', 'eyes', 'shadow', 'fx'], 'subtle', 'pointer'),
  action('pushPointerAway', '把鼠标指针推开', 'pointer', false, 950, 'pointer', 'push', ['motionLines', 'impact'], ['root', 'body', 'head', 'eyes', 'appendages', 'fx'], 'strong', 'pointer'),

  // 情绪
  action('happy', '开心', 'emotion', false, 1500, 'state', 'emote', ['sparkle', 'squashStretch'], ['body', 'head', 'eyes', 'mouth', 'fx'], 'medium'),
  action('laugh', '大笑', 'emotion', false, 1600, 'state', 'emote', ['soundWave', 'squashStretch'], ['body', 'head', 'eyes', 'mouth', 'fx'], 'strong'),
  action('shy', '害羞', 'emotion', false, 1800, 'state', 'emote', ['heart', 'gaze'], ['body', 'head', 'eyes', 'mouth', 'fx'], 'subtle'),
  action('angry', '生气', 'emotion', false, 1700, 'state', 'emote', ['angerMark', 'motionLines'], ['body', 'head', 'eyes', 'mouth', 'fx'], 'strong'),
  action('wronged', '委屈', 'emotion', false, 1900, 'state', 'emote', ['tear', 'gaze'], ['body', 'head', 'eyes', 'mouth', 'fx'], 'subtle'),
  action('sad', '难过', 'emotion', false, 2000, 'state', 'emote', ['tear', 'shadow'], ['body', 'head', 'eyes', 'mouth', 'shadow', 'fx'], 'subtle'),
  action('cry', '哭泣', 'emotion', true, 1600, 'state', 'emote', ['tear', 'soundWave'], ['body', 'head', 'eyes', 'mouth', 'fx'], 'medium'),
  action('surprised', '惊讶', 'emotion', false, 1100, 'state', 'emote', ['exclamationMark', 'squashStretch'], ['body', 'head', 'eyes', 'mouth', 'fx'], 'strong'),
  action('afraid', '害怕', 'emotion', true, 680, 'state', 'shake', ['sweat', 'motionLines'], ['body', 'head', 'eyes', 'mouth', 'fx'], 'strong'),
  action('confused', '疑惑', 'emotion', false, 1800, 'state', 'emote', ['questionMark', 'gaze'], ['body', 'head', 'eyes', 'mouth', 'fx'], 'subtle'),
  action('bored', '无聊', 'emotion', true, 2800, 'state', 'emote', ['bubble', 'gaze'], ['body', 'head', 'eyes', 'mouth', 'fx'], 'subtle'),
  action('sleepy', '困倦', 'emotion', true, 2400, 'state', 'yawn', ['zzz', 'bubble'], ['body', 'head', 'eyes', 'mouth', 'fx'], 'subtle'),
  action('proud', '得意', 'emotion', false, 1800, 'state', 'emote', ['sparkle', 'pose'], ['body', 'head', 'eyes', 'mouth', 'fx'], 'medium'),
  action('impatient', '不耐烦', 'emotion', false, 1700, 'state', 'shake', ['angerMark', 'gaze'], ['body', 'head', 'eyes', 'mouth', 'fx'], 'medium'),
  action('expectant', '期待', 'emotion', true, 1300, 'state', 'emote', ['sparkle', 'gaze'], ['body', 'head', 'eyes', 'mouth', 'fx'], 'medium'),
  action('loveReaction', '喜欢或爱心反应', 'emotion', false, 1800, 'state', 'emote', ['heart', 'sparkle'], ['body', 'head', 'eyes', 'mouth', 'fx'], 'medium'),

  // 养成与生活
  action('eat', '吃东西', 'life', false, 2400, 'command', 'consume', ['food', 'sparkle'], ['body', 'head', 'eyes', 'mouth', 'prop', 'fx'], 'medium'),
  action('drink', '喝水', 'life', false, 2200, 'command', 'consume', ['water', 'sparkle'], ['body', 'head', 'eyes', 'mouth', 'prop', 'fx'], 'medium'),
  action('receiveFood', '接过食物', 'life', false, 1100, 'command', 'handoff', ['food', 'prop'], ['root', 'body', 'head', 'eyes', 'appendages', 'prop'], 'medium'),
  action('refuseFood', '拒绝食物', 'life', false, 1600, 'command', 'refusal', ['questionMark', 'food'], ['body', 'head', 'eyes', 'mouth', 'prop', 'fx'], 'medium'),
  action('full', '吃饱', 'life', false, 1900, 'state', 'emote', ['sparkle', 'squashStretch'], ['body', 'head', 'eyes', 'mouth', 'fx'], 'subtle'),
  action('hungry', '饥饿', 'life', true, 2600, 'state', 'emote', ['food', 'bubble'], ['body', 'head', 'eyes', 'mouth', 'fx'], 'subtle'),
  action('bathe', '洗澡', 'life', true, 1800, 'command', 'bathe', ['water', 'bubble', 'clean'], ['body', 'head', 'eyes', 'prop', 'fx'], 'medium'),
  action('dryOff', '擦干', 'life', false, 1700, 'command', 'groom', ['clean', 'motionLines'], ['body', 'head', 'appendages', 'prop', 'fx'], 'strong'),
  action('groom', '梳毛或整理衣服', 'life', false, 2100, 'command', 'groom', ['clean', 'sparkle', 'outfit'], ['body', 'head', 'appendages', 'prop', 'fx'], 'subtle'),
  action('playToy', '玩玩具', 'life', true, 1600, 'command', 'propUse', ['prop', 'sparkle'], ['root', 'body', 'head', 'eyes', 'appendages', 'prop', 'fx'], 'strong'),
  action('readBook', '看书', 'life', true, 3000, 'command', 'propUse', ['prop', 'gaze'], ['body', 'head', 'eyes', 'appendages', 'prop'], 'subtle'),
  action('usePhone', '玩手机', 'life', true, 2400, 'command', 'propUse', ['prop', 'notification'], ['body', 'head', 'eyes', 'appendages', 'prop', 'fx'], 'subtle'),
  action('listenMusic', '听音乐', 'life', true, 1900, 'command', 'propUse', ['soundWave', 'prop'], ['body', 'head', 'eyes', 'prop', 'fx'], 'medium'),
  action('exercise', '锻炼', 'life', true, 900, 'command', 'exercise', ['motionLines', 'sweat'], ['root', 'body', 'head', 'appendages', 'fx'], 'strong'),
  action('sick', '生病', 'life', true, 2600, 'state', 'illness', ['sweat', 'errorMark'], ['body', 'head', 'eyes', 'mouth', 'fx'], 'subtle'),
  action('takeMedicine', '吃药', 'life', false, 2100, 'command', 'consume', ['medicine', 'prop'], ['body', 'head', 'eyes', 'mouth', 'appendages', 'prop', 'fx'], 'medium'),
  action('recoverEnergy', '恢复精神', 'life', false, 1800, 'state', 'emote', ['sparkle', 'squashStretch'], ['root', 'body', 'head', 'eyes', 'fx'], 'strong'),
  action('levelUp', '升级或成长', 'life', false, 2400, 'state', 'transform', ['confetti', 'sparkle'], ['root', 'body', 'head', 'fx'], 'strong', 'vertical'),
  action('receiveGift', '获得礼物', 'life', false, 1500, 'command', 'handoff', ['gift', 'sparkle'], ['root', 'body', 'head', 'eyes', 'appendages', 'prop', 'fx'], 'medium'),
  action('unwrapGift', '拆礼物', 'life', false, 2600, 'command', 'propUse', ['gift', 'confetti'], ['body', 'head', 'eyes', 'appendages', 'prop', 'fx'], 'strong'),
  action('changeOutfit', '换装', 'life', false, 2100, 'command', 'transform', ['outfit', 'sparkle'], ['root', 'body', 'head', 'prop', 'fx'], 'medium'),

  // 功能动作
  action('remindUser', '提醒用户', 'function', false, 1600, 'system', 'attention', ['notification', 'exclamationMark'], ['root', 'body', 'head', 'eyes', 'fx'], 'strong'),
  action('holdSign', '举牌提示', 'function', true, 1800, 'command', 'propUse', ['sign', 'prop'], ['root', 'body', 'head', 'appendages', 'prop'], 'medium'),
  action('knockScreen', '敲屏幕', 'function', false, 1200, 'system', 'attention', ['impact', 'screenEdge'], ['root', 'body', 'head', 'appendages', 'fx'], 'strong', 'screenEdge'),
  action('pointNotification', '指向通知', 'function', true, 1300, 'system', 'attention', ['notification', 'gaze'], ['root', 'body', 'head', 'eyes', 'appendages', 'fx'], 'medium'),
  action('think', '思考', 'function', true, 2200, 'state', 'thinking', ['questionMark', 'bubble'], ['body', 'head', 'eyes', 'fx'], 'subtle'),
  action('searching', '搜索中', 'function', true, 1400, 'state', 'searching', ['spinner', 'gaze'], ['body', 'head', 'eyes', 'prop', 'fx'], 'medium'),
  action('loading', '加载中', 'function', true, 1100, 'state', 'loading', ['spinner'], ['body', 'eyes', 'fx'], 'subtle'),
  action('answerQuestion', '回答问题', 'function', false, 2200, 'system', 'speaking', ['soundWave', 'bubble'], ['body', 'head', 'eyes', 'mouth', 'fx'], 'medium'),
  action('recordTodo', '记录待办', 'function', false, 2200, 'command', 'writing', ['prop', 'sparkle'], ['body', 'head', 'eyes', 'appendages', 'prop', 'fx'], 'medium'),
  action('startPomodoro', '番茄钟开始', 'function', false, 1400, 'command', 'timer', ['timer', 'notification'], ['body', 'head', 'eyes', 'prop', 'fx'], 'medium'),
  action('focus', '专注中', 'function', true, 2600, 'state', 'focus', ['gaze', 'timer'], ['body', 'head', 'eyes', 'prop', 'fx'], 'subtle'),
  action('breakReminder', '休息提醒', 'function', false, 1800, 'system', 'attention', ['notification', 'exclamationMark'], ['root', 'body', 'head', 'eyes', 'fx'], 'strong'),
  action('alarm', '闹钟响起', 'function', true, 700, 'schedule', 'alarm', ['soundWave', 'notification'], ['root', 'body', 'head', 'prop', 'fx'], 'strong'),
  action('taskComplete', '任务完成庆祝', 'function', false, 2200, 'system', 'celebrate', ['confetti', 'sparkle'], ['root', 'body', 'head', 'eyes', 'mouth', 'fx'], 'strong'),
  action('operationFailed', '操作失败或报错', 'function', false, 1800, 'system', 'error', ['errorMark', 'sweat'], ['body', 'head', 'eyes', 'mouth', 'fx'], 'medium'),
  action('networkDisconnected', '网络断开', 'function', true, 2300, 'system', 'disconnect', ['offlineBadge', 'errorMark'], ['body', 'head', 'eyes', 'fx'], 'subtle'),
  action('updateComplete', '更新完成', 'function', false, 2000, 'system', 'celebrate', ['confetti', 'sparkle', 'notification'], ['root', 'body', 'head', 'eyes', 'fx'], 'strong'),

  // 特殊时间与彩蛋
  action('morningWakeUp', '早上起床', 'special', false, 2100, 'schedule', 'wakeStretch', ['sparkle', 'squashStretch'], ['root', 'body', 'head', 'eyes', 'fx'], 'medium', 'vertical'),
  action('lunchTime', '中午吃饭', 'special', false, 2400, 'schedule', 'consume', ['food', 'sparkle'], ['body', 'head', 'eyes', 'mouth', 'prop', 'fx'], 'medium'),
  action('eveningSleepy', '晚上犯困', 'special', true, 2600, 'schedule', 'yawn', ['zzz', 'bubble'], ['body', 'head', 'eyes', 'mouth', 'fx'], 'subtle'),
  action('lateNightRestReminder', '深夜催用户休息', 'special', false, 2200, 'schedule', 'attention', ['notification', 'zzz'], ['root', 'body', 'head', 'eyes', 'fx'], 'medium'),
  action('birthdayCelebrate', '生日庆祝', 'special', false, 3200, 'schedule', 'celebrate', ['confetti', 'gift', 'sparkle'], ['root', 'body', 'head', 'eyes', 'mouth', 'prop', 'fx'], 'strong'),
  action('holidayAction', '节日动作', 'special', false, 3000, 'schedule', 'propUse', ['confetti', 'outfit', 'prop'], ['root', 'body', 'head', 'prop', 'fx'], 'strong'),
  action('rainUmbrella', '下雨打伞', 'special', true, 1900, 'environment', 'weather', ['weather', 'water', 'prop'], ['root', 'body', 'head', 'appendages', 'prop', 'fx'], 'medium'),
  action('winterShiver', '冬天发抖', 'special', true, 620, 'environment', 'shake', ['weather', 'motionLines'], ['body', 'head', 'appendages', 'fx'], 'medium'),
  action('summerFan', '夏天扇风', 'special', true, 980, 'environment', 'propUse', ['weather', 'motionLines', 'prop'], ['body', 'head', 'appendages', 'prop', 'fx'], 'medium'),
  action('idleSelfEntertainment', '长时间未操作时自娱自乐', 'special', false, 3600, 'idleTimer', 'idlePlay', ['sparkle', 'prop'], ['root', 'body', 'head', 'eyes', 'appendages', 'prop', 'fx'], 'medium'),
  action('welcomeUserBack', '用户回到电脑时欢迎', 'special', false, 2100, 'system', 'attention', ['sparkle', 'heart'], ['root', 'body', 'head', 'eyes', 'mouth', 'fx'], 'strong'),
  action('overworkRestReminder', '连续工作过久时提醒休息', 'special', false, 2400, 'system', 'attention', ['notification', 'timer'], ['root', 'body', 'head', 'eyes', 'fx'], 'strong'),
  action('hiddenEasterEgg', '隐藏彩蛋动作', 'special', false, 4200, 'command', 'idlePlay', ['confetti', 'sparkle', 'questionMark'], ['root', 'body', 'head', 'eyes', 'mouth', 'appendages', 'prop', 'fx'], 'strong'),

  // 必要过渡：动作控制器使用这些桥接离散状态，避免瞬间跳帧。
  action('enterToIdle', '出场到待机过渡', 'transition', false, 320, 'transition', 'transition', ['fade', 'shadow'], ['root', 'body', 'shadow'], 'subtle'),
  action('idleToWalk', '站立到行走过渡', 'transition', false, 320, 'transition', 'transition', ['squashStretch', 'motionLines'], ['root', 'body', 'appendages', 'shadow'], 'medium'),
  action('walkToIdle', '行走到停止过渡', 'transition', false, 420, 'transition', 'decelerate', ['dust', 'squashStretch'], ['root', 'body', 'appendages', 'shadow'], 'medium'),
  action('walkToTurn', '行走到转身过渡', 'transition', false, 360, 'transition', 'transition', ['motionLines', 'squashStretch'], ['root', 'body', 'head', 'shadow'], 'medium', 'bidirectional'),
  action('turnToWalk', '转身到行走过渡', 'transition', false, 360, 'transition', 'transition', ['motionLines', 'shadow'], ['root', 'body', 'head', 'appendages', 'shadow'], 'medium', 'bidirectional'),
  action('idleToSit', '站立到坐下过渡', 'transition', false, 520, 'transition', 'transition', ['squashStretch', 'shadow'], ['root', 'body', 'appendages', 'shadow'], 'subtle', 'vertical'),
  action('sitToIdle', '坐下到站立过渡', 'transition', false, 560, 'transition', 'transition', ['squashStretch', 'shadow'], ['root', 'body', 'appendages', 'shadow'], 'medium', 'vertical'),
  action('idleToSleep', '站立到睡觉过渡', 'transition', false, 1050, 'transition', 'sleepTransition', ['zzz', 'fade'], ['root', 'body', 'head', 'eyes', 'shadow', 'fx'], 'subtle', 'vertical'),
  action('sleepToWake', '睡眠到醒来过渡', 'transition', false, 900, 'transition', 'wakeStretch', ['sparkle', 'fade'], ['root', 'body', 'head', 'eyes', 'shadow', 'fx'], 'medium', 'vertical'),
  action('dragToDrop', '拖拽到放下过渡', 'transition', false, 300, 'transition', 'falling', ['motionLines', 'shadow'], ['root', 'body', 'shadow'], 'medium', 'vertical'),
  action('takeOffToAirborne', '起跳到腾空过渡', 'transition', false, 180, 'transition', 'transition', ['motionLines', 'shadow'], ['root', 'body', 'shadow'], 'medium', 'vertical'),
  action('airborneToLand', '腾空到落地过渡', 'transition', false, 220, 'transition', 'transition', ['motionLines', 'impact'], ['root', 'body', 'shadow'], 'strong', 'vertical'),
  action('idleToExit', '待机到退场过渡', 'transition', false, 360, 'transition', 'transition', ['fade', 'shadow'], ['root', 'body', 'shadow'], 'subtle'),

  // 内部稳定态：允许任意模型为长时姿态提供可循环实现。
  action('sittingLoop', '坐姿循环', 'internal', true, 2600, 'internal', 'holdPose', ['pose', 'shadow'], ['root', 'body', 'head', 'eyes', 'shadow'], 'subtle'),
  action('lyingLoop', '趴姿循环', 'internal', true, 2800, 'internal', 'holdPose', ['pose', 'shadow'], ['root', 'body', 'head', 'eyes', 'shadow'], 'subtle'),
  action('airborneLoop', '腾空循环', 'internal', true, 680, 'internal', 'holdPose', ['motionLines', 'shadow'], ['root', 'body', 'shadow'], 'medium', 'vertical'),
  action('heldLoop', '被抓住循环', 'internal', true, 560, 'internal', 'suspended', ['motionLines'], ['root', 'body', 'head', 'appendages'], 'medium', 'pointer'),
  action('hidden', '隐藏状态', 'internal', true, 1000, 'internal', 'hidden', ['fade'], ['root'], 'subtle'),
] as const;

function catalogIds<const Catalog extends readonly { readonly id: string }[]>(
  catalog: Catalog,
): { readonly [Index in keyof Catalog]: Catalog[Index]['id'] } {
  return catalog.map(({ id }) => id) as unknown as {
    readonly [Index in keyof Catalog]: Catalog[Index]['id'];
  };
}

export const PET_ACTION_IDS = catalogIds(PET_ACTION_CATALOG);
export type PetActionId = (typeof PET_ACTION_IDS)[number];

const ACTION_BY_ID = new Map<PetActionId, PetActionDefinition<PetActionId>>(
  PET_ACTION_CATALOG.map((definition) => [definition.id, definition]),
);

export function getPetAction(id: PetActionId): PetActionDefinition<PetActionId> {
  const definition = ACTION_BY_ID.get(id);
  if (!definition) {
    throw new Error(`Unknown pet action: ${id}`);
  }
  return definition;
}

export function getPetActionsByCategory(
  category: PetActionCategory,
): readonly PetActionDefinition<PetActionId>[] {
  return PET_ACTION_CATALOG.filter((definition) => definition.category === category);
}

export interface PetRequirementChecklistItem<RequirementId extends string = string> {
  readonly requirementId: RequirementId;
  readonly label: string;
  readonly category: PetActionCategory;
  readonly source: 'user' | 'architecture';
  readonly actionIds: readonly PetActionId[];
}

function requirement<
  const RequirementId extends string,
  const ActionIds extends readonly PetActionId[],
>(
  requirementId: RequirementId,
  label: string,
  category: PetActionCategory,
  source: 'user' | 'architecture',
  actionIds: ActionIds,
): PetRequirementChecklistItem<RequirementId> & { readonly actionIds: ActionIds } {
  return { requirementId, label, category, source, actionIds };
}

/** One row for every bullet in the requested scope, plus transition/internal rows. */
export const PET_REQUIREMENT_CHECKLIST = [
  requirement('basic.idle', '待机：正常站立、呼吸、眨眼', 'basic', 'user', ['idle', 'breathe', 'blink']),
  requirement('basic.idleVariation', '待机变化：东张西望、伸懒腰、打哈欠', 'basic', 'user', ['lookAround', 'stretch', 'yawn']),
  requirement('basic.walk', '行走：向左走、向右走', 'basic', 'user', ['walkLeft', 'walkRight']),
  requirement('basic.stop', '停止：从行走切换到站立', 'basic', 'user', ['stopWalking']),
  requirement('basic.turn', '转身：左右方向切换', 'basic', 'user', ['turnLeft', 'turnRight']),
  requirement('basic.dragged', '被拖拽：被鼠标抓起或悬空', 'basic', 'user', ['dragged']),
  requirement('basic.drop', '放下：落地、站稳', 'basic', 'user', ['drop']),
  requirement('basic.clickFeedback', '点击反馈：看向用户、抖动或表情', 'basic', 'user', ['clickFeedback']),
  requirement('basic.sleep', '睡觉：入睡、睡眠循环、醒来', 'basic', 'user', ['sleepIn', 'sleepLoop', 'wake']),
  requirement('basic.visibility', '消失与出现：进入桌面、退出桌面', 'basic', 'user', ['enter', 'exit']),

  requirement('movement.run', '跑步', 'movement', 'user', ['runLeft', 'runRight']),
  requirement('movement.jump', '跳跃', 'movement', 'user', ['jump']),
  requirement('movement.takeOffAndLand', '起跳与落地', 'movement', 'user', ['takeOff', 'land']),
  requirement('movement.fallAndRecover', '摔倒与爬起', 'movement', 'user', ['fallDown', 'recoverFromFall']),
  requirement('movement.sitAndStand', '坐下与起身', 'movement', 'user', ['sitDown', 'standUp']),
  requirement('movement.lieAndRise', '趴下与起身', 'movement', 'user', ['lieDown', 'riseFromLie']),
  requirement('movement.slide', '滑动', 'movement', 'user', ['slide']),
  requirement('movement.climbScreenEdge', '沿屏幕边缘攀爬', 'movement', 'user', ['climbScreenEdge']),
  requirement('movement.holdWindowEdge', '抓住窗口边缘', 'movement', 'user', ['holdWindowEdge']),
  requirement('movement.peekFromEdge', '从窗口或屏幕边缘探头', 'movement', 'user', ['peekFromEdge']),
  requirement('movement.fallFromHeight', '从高处掉落', 'movement', 'user', ['fallFromHeight']),
  requirement('movement.pushedByWindow', '被窗口推动或挤开', 'movement', 'user', ['pushedByWindow']),

  requirement('pointer.singleClick', '单击反馈', 'pointer', 'user', ['clickFeedback']),
  requirement('pointer.doubleClick', '双击反馈', 'pointer', 'user', ['doubleClick']),
  requirement('pointer.rapidClick', '连续点击后的不耐烦反应', 'pointer', 'user', ['rapidClickAnnoyed']),
  requirement('pointer.hoverLook', '鼠标悬停时看向光标', 'pointer', 'user', ['hoverLookAtPointer']),
  requirement('pointer.trackGaze', '跟随鼠标移动视线', 'pointer', 'user', ['trackPointerGaze']),
  requirement('pointer.dragReaction', '被拖拽时挣扎、放松或晃动', 'pointer', 'user', ['dragStruggle']),
  requirement('pointer.petHead', '抚摸头部', 'pointer', 'user', ['petHead']),
  requirement('pointer.poke', '戳脸、戳身体', 'pointer', 'user', ['pokeFace', 'pokeBody']),
  requirement('pointer.chased', '被鼠标追赶', 'pointer', 'user', ['chasedByPointer']),
  requirement('pointer.catch', '抓住鼠标指针', 'pointer', 'user', ['catchPointer']),
  requirement('pointer.sitOn', '坐在鼠标指针上', 'pointer', 'user', ['sitOnPointer']),
  requirement('pointer.pushAway', '把鼠标指针推开', 'pointer', 'user', ['pushPointerAway']),

  requirement('emotion.happy', '开心', 'emotion', 'user', ['happy']),
  requirement('emotion.laugh', '大笑', 'emotion', 'user', ['laugh']),
  requirement('emotion.shy', '害羞', 'emotion', 'user', ['shy']),
  requirement('emotion.angry', '生气', 'emotion', 'user', ['angry']),
  requirement('emotion.wronged', '委屈', 'emotion', 'user', ['wronged']),
  requirement('emotion.sad', '难过', 'emotion', 'user', ['sad']),
  requirement('emotion.cry', '哭泣', 'emotion', 'user', ['cry']),
  requirement('emotion.surprised', '惊讶', 'emotion', 'user', ['surprised']),
  requirement('emotion.afraid', '害怕', 'emotion', 'user', ['afraid']),
  requirement('emotion.confused', '疑惑', 'emotion', 'user', ['confused']),
  requirement('emotion.bored', '无聊', 'emotion', 'user', ['bored']),
  requirement('emotion.sleepy', '困倦', 'emotion', 'user', ['sleepy']),
  requirement('emotion.proud', '得意', 'emotion', 'user', ['proud']),
  requirement('emotion.impatient', '不耐烦', 'emotion', 'user', ['impatient']),
  requirement('emotion.expectant', '期待', 'emotion', 'user', ['expectant']),
  requirement('emotion.love', '喜欢或爱心反应', 'emotion', 'user', ['loveReaction']),

  requirement('life.eat', '吃东西', 'life', 'user', ['eat']),
  requirement('life.drink', '喝水', 'life', 'user', ['drink']),
  requirement('life.receiveFood', '接过食物', 'life', 'user', ['receiveFood']),
  requirement('life.refuseFood', '拒绝食物', 'life', 'user', ['refuseFood']),
  requirement('life.full', '吃饱', 'life', 'user', ['full']),
  requirement('life.hungry', '饥饿', 'life', 'user', ['hungry']),
  requirement('life.bathe', '洗澡', 'life', 'user', ['bathe']),
  requirement('life.dryOff', '擦干', 'life', 'user', ['dryOff']),
  requirement('life.groom', '梳毛或整理衣服', 'life', 'user', ['groom']),
  requirement('life.playToy', '玩玩具', 'life', 'user', ['playToy']),
  requirement('life.readBook', '看书', 'life', 'user', ['readBook']),
  requirement('life.usePhone', '玩手机', 'life', 'user', ['usePhone']),
  requirement('life.listenMusic', '听音乐', 'life', 'user', ['listenMusic']),
  requirement('life.exercise', '锻炼', 'life', 'user', ['exercise']),
  requirement('life.sick', '生病', 'life', 'user', ['sick']),
  requirement('life.takeMedicine', '吃药', 'life', 'user', ['takeMedicine']),
  requirement('life.recoverEnergy', '恢复精神', 'life', 'user', ['recoverEnergy']),
  requirement('life.levelUp', '升级或成长', 'life', 'user', ['levelUp']),
  requirement('life.receiveGift', '获得礼物', 'life', 'user', ['receiveGift']),
  requirement('life.unwrapGift', '拆礼物', 'life', 'user', ['unwrapGift']),
  requirement('life.changeOutfit', '换装', 'life', 'user', ['changeOutfit']),

  requirement('function.remindUser', '提醒用户', 'function', 'user', ['remindUser']),
  requirement('function.holdSign', '举牌提示', 'function', 'user', ['holdSign']),
  requirement('function.knockScreen', '敲屏幕', 'function', 'user', ['knockScreen']),
  requirement('function.pointNotification', '指向通知', 'function', 'user', ['pointNotification']),
  requirement('function.think', '思考', 'function', 'user', ['think']),
  requirement('function.searching', '搜索中', 'function', 'user', ['searching']),
  requirement('function.loading', '加载中', 'function', 'user', ['loading']),
  requirement('function.answerQuestion', '回答问题', 'function', 'user', ['answerQuestion']),
  requirement('function.recordTodo', '记录待办', 'function', 'user', ['recordTodo']),
  requirement('function.startPomodoro', '番茄钟开始', 'function', 'user', ['startPomodoro']),
  requirement('function.focus', '专注中', 'function', 'user', ['focus']),
  requirement('function.breakReminder', '休息提醒', 'function', 'user', ['breakReminder']),
  requirement('function.alarm', '闹钟响起', 'function', 'user', ['alarm']),
  requirement('function.taskComplete', '任务完成庆祝', 'function', 'user', ['taskComplete']),
  requirement('function.operationFailed', '操作失败或报错', 'function', 'user', ['operationFailed']),
  requirement('function.networkDisconnected', '网络断开', 'function', 'user', ['networkDisconnected']),
  requirement('function.updateComplete', '更新完成', 'function', 'user', ['updateComplete']),

  requirement('special.morningWakeUp', '早上起床', 'special', 'user', ['morningWakeUp']),
  requirement('special.lunchTime', '中午吃饭', 'special', 'user', ['lunchTime']),
  requirement('special.eveningSleepy', '晚上犯困', 'special', 'user', ['eveningSleepy']),
  requirement('special.lateNightRest', '深夜催用户休息', 'special', 'user', ['lateNightRestReminder']),
  requirement('special.birthday', '生日庆祝', 'special', 'user', ['birthdayCelebrate']),
  requirement('special.holiday', '节日动作', 'special', 'user', ['holidayAction']),
  requirement('special.rain', '下雨打伞', 'special', 'user', ['rainUmbrella']),
  requirement('special.winter', '冬天发抖', 'special', 'user', ['winterShiver']),
  requirement('special.summer', '夏天扇风', 'special', 'user', ['summerFan']),
  requirement('special.idlePlay', '长时间未操作时自娱自乐', 'special', 'user', ['idleSelfEntertainment']),
  requirement('special.welcomeBack', '用户回到电脑时欢迎', 'special', 'user', ['welcomeUserBack']),
  requirement('special.overworkRest', '连续工作过久时提醒休息', 'special', 'user', ['overworkRestReminder']),
  requirement('special.easterEgg', '隐藏彩蛋动作', 'special', 'user', ['hiddenEasterEgg']),

  requirement('transition.enterToIdle', '出场到待机过渡', 'transition', 'architecture', ['enterToIdle']),
  requirement('transition.idleToWalk', '站立到行走过渡', 'transition', 'architecture', ['idleToWalk']),
  requirement('transition.walkToIdle', '行走到停止过渡', 'transition', 'architecture', ['walkToIdle']),
  requirement('transition.walkToTurn', '行走到转身过渡', 'transition', 'architecture', ['walkToTurn']),
  requirement('transition.turnToWalk', '转身到行走过渡', 'transition', 'architecture', ['turnToWalk']),
  requirement('transition.idleToSit', '站立到坐下过渡', 'transition', 'architecture', ['idleToSit']),
  requirement('transition.sitToIdle', '坐下到站立过渡', 'transition', 'architecture', ['sitToIdle']),
  requirement('transition.idleToSleep', '站立到睡觉过渡', 'transition', 'architecture', ['idleToSleep']),
  requirement('transition.sleepToWake', '睡眠到醒来过渡', 'transition', 'architecture', ['sleepToWake']),
  requirement('transition.dragToDrop', '拖拽到放下过渡', 'transition', 'architecture', ['dragToDrop']),
  requirement('transition.takeOffToAirborne', '起跳到腾空过渡', 'transition', 'architecture', ['takeOffToAirborne']),
  requirement('transition.airborneToLand', '腾空到落地过渡', 'transition', 'architecture', ['airborneToLand']),
  requirement('transition.idleToExit', '待机到退场过渡', 'transition', 'architecture', ['idleToExit']),
  requirement('internal.sitting', '坐姿稳定态', 'internal', 'architecture', ['sittingLoop']),
  requirement('internal.lying', '趴姿稳定态', 'internal', 'architecture', ['lyingLoop']),
  requirement('internal.airborne', '腾空稳定态', 'internal', 'architecture', ['airborneLoop']),
  requirement('internal.held', '被抓住稳定态', 'internal', 'architecture', ['heldLoop']),
  requirement('internal.hidden', '隐藏稳定态', 'internal', 'architecture', ['hidden']),
] as const;

export type PetRequirementId = (typeof PET_REQUIREMENT_CHECKLIST)[number]['requirementId'];

export const PET_FIRST_RELEASE_CHECKLIST = [
  { ordinal: 1, label: '待机循环', actionIds: ['idle', 'breathe'] },
  { ordinal: 2, label: '眨眼', actionIds: ['blink'] },
  { ordinal: 3, label: '特殊待机', actionIds: ['lookAround', 'stretch', 'yawn'] },
  { ordinal: 4, label: '左走', actionIds: ['walkLeft'] },
  { ordinal: 5, label: '右走', actionIds: ['walkRight'] },
  { ordinal: 6, label: '转身', actionIds: ['turnLeft', 'turnRight'] },
  { ordinal: 7, label: '坐下', actionIds: ['sitDown'] },
  { ordinal: 8, label: '起身', actionIds: ['standUp'] },
  { ordinal: 9, label: '被拖拽', actionIds: ['dragged'] },
  { ordinal: 10, label: '放下', actionIds: ['drop'] },
  { ordinal: 11, label: '点击反馈', actionIds: ['clickFeedback'] },
  { ordinal: 12, label: '开心', actionIds: ['happy'] },
  { ordinal: 13, label: '生气', actionIds: ['angry'] },
  { ordinal: 14, label: '困倦', actionIds: ['sleepy'] },
  { ordinal: 15, label: '入睡', actionIds: ['sleepIn'] },
  { ordinal: 16, label: '睡眠循环', actionIds: ['sleepLoop'] },
  { ordinal: 17, label: '醒来', actionIds: ['wake'] },
  { ordinal: 18, label: '出场和退场', actionIds: ['enter', 'exit'] },
] as const satisfies readonly {
  readonly ordinal: number;
  readonly label: string;
  readonly actionIds: readonly PetActionId[];
}[];
