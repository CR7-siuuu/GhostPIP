# Phase 0 실측 결과

> 일회성 실험 코드입니다. 배포 코드에는 포함하지 않습니다.
> 환경: Windows, Chrome 156.0.8078.48, 단일 모니터 2560×1440 (DPR 1), RTX 4070 Ti

| 가설 | 결과 | 근거 (스크립트) |
|---|---|---|
| H3. Document PiP의 OS 창 제목에 `pipWindow.document.title`이 반영됨 | ❌ **거짓** | `h3_detect.py` |
| H3'. `pipWindow.screenX/Y/outerWidth/outerHeight` == `GetWindowRect` | ✅ 정확히 일치 (DPR 1) | `h3_detect.py` |
| H3''. Document PiP를 user activation 없이 열 수 있음 | ❌ `NotAllowedError` | `h3_detect.py` |
| H5. `captureStream()` 복제가 사이트 원본을 건드리지 않고 PiP 안에서 재생됨 | ✅ YouTube(VOD/라이브), 치지직, SOOP, Twitch | `h5_mirror.py` |
| H5'. 팝아웃 채팅 URL을 Document PiP 안 iframe으로 띄울 수 있음 | ✅ YouTube / 🟡 치지직·Twitch는 로드 확인, 메시지 수신은 미확인 | `h5_mirror.py`, `h5_debug.py` |
| H6. `position: fixed`로 원본 `<video>`를 띄우기 | ❌ 4개 사이트 모두 실패 | `h6_inpage.py` |
| H6'. Popover Top Layer + `@layer`로 원본 `<video>`를 띄우기 | ✅ 4개 사이트 모두 성공 | `h6_inpage.py` |
| H1. 다른 프로세스에서 건 `WS_EX_LAYERED` 반투명이 Chrome PiP에 정상 렌더링됨 | ✅ 기본 PiP, Document PiP 모두 | `h1h2_ghost.py` (사용자 실행) |
| H2. `WS_EX_TRANSPARENT`를 걸면 클릭이 아래 창으로 통과함 | ✅ 통과함, PiP가 포커스를 가져가지 않음 | `h1h2_ghost.py` (사용자 실행) |
| H2'. `WS_EX_LAYERED`를 그냥 제거하면 원상 복구됨 | ✅ 복구됨 (첫 실행의 ❌는 **실험 오류**: 클릭 통과 테스트에서 클릭을 받은 항상 위 배경창이 활성화되어 PiP 위로 올라온 것) | `h7_restore.py` |
| H4. 일반 권한 엔진이 관리자 권한 창에 포커스가 있을 때 `RegisterHotKey`를 받음 | ✅ 받음 | `h4_hotkeys.py` (사용자 실행) |
| H4'. 같은 상황에서 `GetAsyncKeyState`로 Ctrl+Alt를 감지함 | ❌ **0ms** (일반 권한 창에 포커스가 있으면 590ms 감지) | `h4_hotkeys.py` |
| H7. 반투명 해제 시 PiP를 복구하는 방법 | ✅ 6가지 모두 복구됨 (단순 제거 포함) | `h7_restore.py` (사용자 실행) |
| H8. 관리자 권한 창에 포커스가 있을 때 Ctrl+Alt 누름/뗌을 감지하는 수단 | ❌ Raw Input, LL 훅, 핫키 **모두 0회** (일반 권한 창 포커스 시 Raw Input·LL 훅 각 3/3회) | `h8_hold.py` (사용자 실행) |

## 세부 관측

### H3 창 탐지
```
기본 PiP     : title="PIP 모드"(한국어 로케일), ex=0x200108(TOPMOST), Chrome_WidgetWin_1
Document PiP : title="<원래 페이지의 제목>", ex=0x200108(TOPMOST)
               원래 페이지의 document.title을 바꾸면 PiP 창 제목도 따라 바뀜
               pipWindow.document.title은 OS 창 제목에 반영되지 않음
```
→ 창 제목으로 PiP를 찾는 방식은 폐기합니다. **브라우저 프로세스 + TOPMOST + 확장이 보낸 rect 일치**로 짝을 맞춥니다.

### H5 미러링 (`video.captureStream()` → PiP 안 `<video>.srcObject`)
| 사이트 | 원본 해상도 | 미러 루마/표준편차 | 원본 계속 재생 | 원본 DOM 위치 유지 | 채팅 iframe |
|---|---|---|---|---|---|
| YouTube VOD | 320×240 | 114 / 52 | +2.61s | ✅ | — |
| YouTube 라이브 | 1280×720 | 197 / 64 | +2.58s | ✅ | ✅ 텍스트 2220자 |
| 치지직 | 1920×1080 | 155 / 56 | +2.57s | ✅ | 🟡 로드됨 (환영 문구, 랭킹 표시) |
| SOOP | 960×540 | 143 / 57 | +2.55s | ✅ | 미시험 (팝아웃 URL 미확정) |
| Twitch | 1920×1080 | 109 / 51 | +2.00s | ✅ | 🟡 로드됨 |

- 표준편차가 0보다 크므로 검은 화면이 아니라 실제 영상 프레임이 복제되고 있습니다.
- SOOP 재생 도메인은 `play.sooplive.com`입니다(`.co.kr`이 아님). 권한 목록에 반영해야 합니다.
- Netflix 같은 DRM 콘텐츠는 실측하지 않았습니다(로그인 필요). DRM이면 기본 PiP로 폴백하는 규칙을 유지합니다.

### H6 탭 안 플로팅 (뷰포트 1264×805, 목표 위치: 우하단 480×270)
| 사이트 | `position: fixed` | Popover + `@layer` |
|---|---|---|
| YouTube | 위치는 맞지만 추천 영상 썸네일(IMG)에 **가려짐** | ✅ 최상단 |
| 치지직 | transform 조상(`SECTION._container`) 영향으로 채팅 패널에 **가려지고 잘림** | ✅ 최상단 |
| SOOP | 페이지 모달 아래에 **가려짐** | ✅ 최상단 (`@layer` 적용 전에는 사이트의 `!important` 규칙 때문에 크기가 깨졌음) |
| Twitch | transform 조상(`InjectLayout`) 때문에 **엉뚱한 위치**(428,197) | ✅ 정확한 위치 |

- 두 방식 모두 원본 `<video>`의 부모와 형제 노드는 그대로이고 재생도 계속됩니다.
- 스크린샷: `out/h6_*.png`

### H1/H2 사용자 실행 결과 (마젠타 배경 위 초록 PiP, 중앙 100×60 평균색)
| | 기본 PiP | Document PiP | 기대값 |
|---|---|---|---|
| 원래 상태 | (0,245,0) | (0,255,0) | 초록 |
| 알파 50% | (127,123,127) | (127,128,127) | (128,128,128) |
| 50% 상태 3초간 밝기 범위 | 377~382 | 382~382 | 변동 거의 없음 = 깜빡임 없음 |
| 알파 10% | (229,26,229) | (229,26,229) | 마젠타 90% + 초록 10% |
| 창을 옮긴 뒤 LAYERED 유지 | ✅ | ✅ | |
| 클릭 통과 (TRANSPARENT 없음 / 있음) | 0 / 1 | 0 / 1 | 0 / 1 |
| `WS_EX_LAYERED` 제거 직후 | (255,0,255) | (255,0,255) | 실험 오류: 클릭을 받은 항상 위 배경창이 PiP 위로 올라옴 (H7에서 복구 확인) |

### H4 사용자 실행 결과 (엔진 일반 권한)
| 포커스를 가진 창 | `RegisterHotKey` Alt+G | `GetAsyncKeyState` Ctrl+Alt (600ms 유지) |
|---|---|---|
| 일반 권한 창 | ✅ 1회 수신 | ✅ 590ms |
| **관리자 권한 창** | ✅ 1회 수신 | ❌ 0ms |

→ 전역 핫키는 관리자 권한 없이 동작합니다.

### H7 복구 방법 비교 (반투명 50% + 클릭 통과 상태에서 복구, 0.7초 후 / 2.7초 후)
기본 PiP와 Document PiP 모두 6가지 방법(알파 255로 유지, 제거+RedrawWindow, 제거+FRAMECHANGED, 제거+크기 흔들기, 제거+숨김/표시, 단순 제거)이 **전부 초록으로 복구**됐습니다. → 단순 제거로 충분합니다.

### H8 Hold 감지 수단 (엔진 일반 권한, Ctrl+Alt 600ms 유지 주입)
| 포커스를 가진 창 | Raw Input (INPUTSINK) | WH_KEYBOARD_LL | `GetAsyncKeyState` |
|---|---|---|---|
| 일반 권한 창 | 누름 3 / 뗌 3 | 누름 3 / 뗌 3 | 575ms |
| **관리자 권한 창** | 0 / 0 | 0 / 0 | 0ms |

→ 관리자 권한 창이 포커스를 가진 동안에는 **일반 권한 프로세스가 수정 키 상태를 관찰할 방법이 없습니다**(UIPI). 반면 `RegisterHotKey`는 동작합니다(H4).
→ 결정: 관리자 권한 게임 위에서는 Hold-to-Interact 대신 **Alt+G(클릭 통과 토글)**로 조작합니다. PiP를 클릭하면 포커스가 Chrome(일반 권한)으로 넘어가므로 그때부터는 Hold 감지가 다시 동작합니다.

### 부수 발견
클릭 통과 상태에서 클릭하면 **PiP 뒤의 창이 활성화**됩니다. 그 창이 항상 위(topmost) 창이면 PiP 위로 올라옵니다. 엔진은 Ghost 적용 중 z-order를 주기적으로 확인해 PiP를 항상 위 그룹의 맨 위로 유지해야 합니다.

## 실험 환경의 제약
에이전트의 명령은 사용자 화면과 분리된 데스크톱에서 실행됩니다(보이는 창 0개, GDI 화면 캡처 실패). 그래서 화면 합성 결과가 필요한 H1/H2와 UAC가 필요한 H4는 **사용자 데스크톱에서 `run_user_tests.ps1`로 실행**해야 합니다. 결과는 `out/user_results.txt`에 저장됩니다.

### H1/H2 판정 기준
- `baseline` ≈ (0,255,0): 초록 PiP가 보임
- `alpha50_first` ≈ (128,128,128): 초록과 마젠타가 반씩 섞임 → 반투명 정상
- `alpha50_min_luma`와 `alpha50_max_luma`의 차이가 작음 → 깜빡임 없음
- `click_reached_bg_with_transparent` = 1, `..._without_transparent` = 0 → 클릭 통과 정상
- `layered_kept_after_move` = true → 창을 옮긴 뒤에도 Chrome이 스타일을 되돌리지 않음

### H4 판정 기준
- 관리자 권한 게임 쪽에서 `wm_hotkey_received` ≥ 1 → 핫키는 관리자 권한 없이 동작
- `ctrl_alt_seen_by_getasynckeystate_ms` > 0 → Hold-to-Interact는 관리자 권한 없이 동작
