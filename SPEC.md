# GhostPiP — Master Technical Specification (v2.3 / App v1.1.1)

> v2.2 대비 변경점: 브라우저 탭 내부에 갇혀 동작하던 구 '웹 모드(In-Tab 플로팅 및 탭 간 캔버스 오버레이)'를 완전히 제거하고, 데스크톱 PiP(Document PiP · 다중 PiP 팝업 창 · DRM 기본 PiP) 단일 모드로 일원화.

## 1. 개요
- **이름**: GhostPiP (고스트핍)
- **버전**: `1.1.1` (확장 및 Windows 엔진 공통)
- **스토어 제목**: GhostPiP - 화면을 안 가리는 투명/클릭통과/자동회피 PIP / GhostPiP - Transparent, Click-Through & Auto-Dodge PiP
- **핵심**: 데스크톱 영상 PiP 창을 (1) 반투명, (2) 클릭 통과, (3) 커서 접근 시 자동 회피(금지 코너 지원), (4) 실시간 자막·리모컨·역 투명화(Peek) 지원
- **플랫폼**: Chrome MV3 (`minimum_chrome_version: 116`) + Windows 10/11 엔진
- **대상 사이트**: 스트리밍(YouTube, 치지직, SOOP, Twitch) 및 OTT(Netflix, Disney+, Prime Video, Coupang Play, TVING, Wavve, Watcha, Laftel, SeriesOn, Apple TV+, Max, Hulu, Paramount+, Peacock, Crunchyroll). 선택적 권한 승인 시 모든 사이트 일반 `<video>` 지원.

## 2. 확정 결정
| 항목 | 결정 | 근거 |
|---|---|---|
| 모드 구성 | **단일 데스크톱 PiP 모드** (`docPip` / `popupPip` / `nativePip`) | 탭 내부 Popover 플로팅(구 웹 모드)은 사이트 레이아웃 충돌과 탭 간 미러링 오버헤드만 유발하고 게임 오버레이 목적에 부합하지 않아 제거 |
| 확장 ↔ 엔진 연결 | **Native Messaging** (`chrome.runtime.connectNative`) | 정확한 확장 ID만 접속 가능, 열린 포트 없음. 미설치 시 재시도 중단, 단절 시 지수 백오프(1s→60s) |
| 엔진 권한 | **`asInvoker`** (관리자 권한 불필요) | 관리자 권한 게임 위에서도 `RegisterHotKey` 동작. 비관리자 실행 시 `HELLO.elevated=false`로 팝업에 `Alt+G` 조작 안내 표시 |
| 엔진 언어 | **C# .NET 10 Native AOT** (`net10.0-windows`) | Win32 P/Invoke, 단일 실행 파일, 빠른 시작 및 낮은 메모리 사용 |
| 데스크톱 PiP 영상 | **1순위 `documentPictureInPicture` (`captureStream`) · 다중 PiP 시 독립 팝업 창(`player.html` WebRTC 루프백) · DRM 시 기본 PiP** | 원본 재생을 끊지 않고 채팅 결합 및 다중 PiP 동시 실행 지원 |
| Document PiP 호스팅 | **엔진 호스트 창(`SetParent`) + `WS_EX_LAYERED`** | 크롬 창 헤더를 클리핑하고 투명도·클릭 통과·리사이즈를 일관되게 제어 |
| PiP 채팅 | **세션 DNR 규칙(`initiatorDomains` 제한) + 팝아웃 채팅 iframe** | 확장 및 지원 방송 도메인에서만 `x-frame-options`와 `frame-ancestors`를 제거해 클릭재킹·XSS 약화 방지 |
| PiP 창 탐지 | **대기 중인 `PIP_OPENED` 요청 + 브라우저 프로세스 + rect 핸드셰이크** | 요청 없는 임의 TOPMOST 창 오탐 방지, `SendMessageTimeoutW` 및 최소 100ms 열거 쓰로틀 적용 |
| 입력 훅 | **스냅샷 기반 저수준 마우스 훅 + UI 스레드 `PostMessage`** | 훅 콜백에서 Win32/IPC 호출을 배제해 `LowLevelHooksTimeout` 해제를 방지 |

## 3. 데이터 형태와 소유권

### 3.1 설정: `chrome.storage.local`이 유일한 기준
```ts
type Corner = "TL" | "TR" | "BL" | "BR";
type Axis = "free" | "vertical" | "horizontal";
type HoldKey = "Ctrl+Alt" | "Ctrl+Shift" | "Alt+Shift" | "Ctrl" | "Alt" | "Shift";
type PeekKey = "Alt" | "Mouse4" | "Mouse5" | "Backquote" | "Ctrl" | "Shift" | "Ctrl+Alt";

interface Settings {
  enabled: boolean;
  clickThrough: boolean;            // Alt+G
  opacity: number;                  // 0.1..1.0, 기본 0.7
  showChat: boolean;
  allSites: boolean;                // 선택적 호스트 권한(http/https) 필요
  dodge: {
    enabled: boolean;               // Alt+Shift+D
    axis: Axis;
    allowed: Corner[];              // 불변식: 3.3
    home: Corner;
    autoReturn: boolean;
    returnDelayMs: number;          // 100..60000, 기본 2500
    marginPx: number;               // 0..400, 기본 20
    edgeInsetPx: number;            // 0..400, 기본 16
    hoverDelayMs: number;           // 0..5000, 기본 100
    cooldownMs: number;             // 0..10000, 기본 300
    style: "move" | "fade";
    ignoreScreenEdgePx: number;     // 0..400, 0 = 끔
  };
  media: {
    enabled: boolean;
    seekSec: 5 | 10;
    wheelVolume: boolean;
  };
  peek: {
    enabled: boolean;               // Alt+P
    key: PeekKey;
    idleOpacity: number;            // 0..0.5, 기본 0
    activeOpacity: number;          // 0.2..1.0, 기본 0.8
  };
  hotkeys: {
    clickThrough: string;
    dodge: string;
    mute: string;
    playPause: string;
    seekBack: string;
    seekForward: string;
    peek: string;
    hold: HoldKey;
  };
}
```
- `settings`와 `floatLayout` 모두 `background.js`의 직렬화 큐(`PATCH_SETTINGS`, `PATCH_FLOAT_LAYOUT`)만 기록합니다.

### 3.2 프로토콜 (Native Messaging: 4바이트 길이 + UTF-8 JSON)
```ts
type PipKind = "native" | "document" | "popup";

type ToEngine =
  | { v: 1; type: "STATE"; settings: Settings }
  | { v: 1; type: "SESSION_STATE"; activeMedia: boolean; inTabActive: boolean }
  | { v: 1; type: "PIP_OPENED"; tabId: number; kind: PipKind; rect: Rect; dpr: number; savedBounds?: SavedBounds | null }
  | { v: 1; type: "PIP_CLOSED"; tabId: number }
  | { v: 1; type: "PIP_RESIZE"; tabId: number; deltaH: number; dpr: number }
  | { v: 1; type: "PIP_SUBTITLE"; tabId: number; text: string; lines?: string[] }
  | { v: 1; type: "LOCALE"; locale: string; strings?: Record<string, string> }
  | { v: 1; type: "PING" };

type ToExtension =
  | { v: 1; type: "HELLO"; engineVersion: string; elevated: boolean; hotkeyErrors?: string[] }
  | { v: 1; type: "INTENT"; intent:
      | "TOGGLE_CLICK_THROUGH" | "TOGGLE_DODGE" | "TOGGLE_MUTE" | "TOGGLE_PEEK" | "TOGGLE_PIP_CHAT"
      | "EMERGENCY_RELEASE" | "SET_HOME" | "SET_OPACITY"
      | "MEDIA_PLAY_PAUSE" | "MEDIA_SEEK_BACK" | "MEDIA_SEEK_FORWARD" | "MEDIA_VOLUME";
      corner?: Corner; opacity?: number; delta?: number; tabId?: number }
  | { v: 1; type: "PIP_BOUND"; tabId: number }
  | { v: 1; type: "PIP_LOST"; tabId: number; reason: string }
  | { v: 1; type: "PIP_BOUNDS"; tabId: number; kind: PipKind; rect: Rect; dpr: number; corner?: Corner; customPos?: boolean }
  | { v: 1; type: "PIP_HOVER"; tabId: number; hovered: boolean }
  | { v: 1; type: "PEEK_STATE"; active: boolean }
  | { v: 1; type: "PONG" };

interface Rect { x: number; y: number; w: number; h: number }   // CSS px (DIP)
```
- 양쪽 경계에서 `v === 1`, `rect`(`|x|,|y| ≤ 100000`, `w,h 1..20000`), `dpr`(`0.25..8`), `deltaH`(`±4000`)를 검증합니다.
- 256KB를 초과하는 프레임이나 잘못된 JSON은 드레인 후 건너뛰며 프로세스를 종료하지 않습니다.

### 3.3 회피 및 핫키 불변식 (확장 JS와 엔진 C# 공통)
- 회피 불변식: `shared/dodge-vectors.json`으로 JS(`extension/content/dodge.js`)와 C#(`engine/DodgeSolver.cs`)의 동작 일치를 검증합니다.
- 핫키 불변식: `shared/hotkey-vectors.json`으로 JS(`extension/shared/settings.js`)와 C#(`engine/Hotkeys.cs`)이 동일하게 시스템/편집 예약 키(`Ctrl+C`, `Alt+F4` 등) 및 단일 `Shift` 조합을 거부하는지 검증합니다.

## 4. 디렉터리 구조
```
GhostPIP/
├── SPEC.md
├── shared/
│   ├── dodge-vectors.json           # 회피 솔버 공통 테스트 벡터
│   └── hotkey-vectors.json          # 핫키 검증 공통 테스트 벡터
├── extension/
│   ├── manifest.json
│   ├── background.js                # Native Messaging, Settings/Layout 단일 소유, 세션 DNR, 선택 권한
│   ├── config/selectors.json
│   ├── shared/{settings.js, protocol.js, i18n.js}
│   ├── content/{dodge.js, subtitles.js, heuristics.js, overlay-ui.js, relay.js, doc-pip.js, content.js}
│   ├── player/{player.html, player.css, player.js}
│   ├── popup/{popup.html, popup.css, popup.js}
│   └── guide/{guide.html, guide.css, guide.js}
├── engine/
│   ├── GhostPiP.Engine.csproj       # net10.0-windows, PublishAot, v1.1.1
│   ├── app.manifest                 # asInvoker, PerMonitorV2
│   ├── Program.cs                   # 진입점, 메시지 루프, 핫키/트레이, 종료 정리
│   ├── Program.Pointer.cs           # 저수준 마우스 훅, 스냅샷 히트 테스트, 드래그/리사이즈/휠
│   ├── Program.Tick.cs              # 30ms 틱, 다중 PiP 회피/peek/투명도/자막 오케스트레이션
│   ├── Program.Messages.cs          # Native Messaging 수신 디스패치 및 PiP 초기화
│   ├── PointerSession.cs            # 포인터 상태 머신 (Idle | Down | Dragging | Resizing)
│   ├── Dpi.cs                       # 모니터별 DPI 스케일링 및 경계 클램프
│   ├── Protocol.cs                  # 메시지/설정 파서 및 경계 검증
│   ├── NativeMessaging.cs           # 비동기 쓰기 큐(병합 지원) 및 프레임 리더
│   ├── PipTracker.cs                # 대기 요청 기반 창 바인딩 및 WinEvent 훅
│   ├── GhostStyle.cs                # 호스트 창(SetParent), 레이어드 투명도, 클릭 통과
│   ├── DodgeSolver.cs               # 순수 회피 솔버
│   ├── HoldStateMachine.cs          # Hold-to-Interact 상태 머신
│   ├── Hotkeys.cs                   # 전역 핫키 파서 및 조건부 등록
│   ├── SubtitleOverlay.cs           # 캐시된 5x5 외곽선 자막 오버레이
│   ├── TrayIcon.cs                  # 트레이 아이콘 및 다국어 메뉴
│   ├── SelfTest.cs                  # --self-test 스위트
│   └── installer/                   # NativeMessagingHosts 등록(-Dev 지원), 정상 종료 대기
└── test/
    ├── unit/*.test.mjs              # 단위 테스트
    └── e2e/*.mjs                    # Puppeteer + Win32 통합 E2E
```
