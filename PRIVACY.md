# GhostPiP Privacy Policy / 개인정보 처리방침

**Effective Date / 시행일:** 2026-11-01

---

## 🇺🇸 English

**GhostPiP does NOT collect, store, transmit, or share any personal data or browsing history.**

- **Local Settings Only (`chrome.storage`)**: GhostPiP stores only your user preferences—such as opacity level, click-through state, auto-dodge corners, keyboard shortcuts, and floating PiP window size/position—locally on your device using `chrome.storage`. This data never leaves your browser.
- **Webpage Access**: GhostPiP accesses the active tab's `<video>` element and player container strictly when you launch or control the floating Picture-in-Picture (PiP) player. It never reads, records, or transmits page text, browsing history, form inputs, cookies, or personal information.
- **Live Stream Chat**: When chat is enabled in Full Mode, GhostPiP embeds the official popout chat page of the streaming platform (YouTube, Twitch, Chzzk, SOOP/AfreecaTV) directly inside the PiP window. GhostPiP does not read, log, or intercept chat messages or account credentials.
- **GhostPiP Engine (Optional Local Helper)**: The optional `GhostPiP.Engine.exe` desktop companion communicates exclusively with the Chrome extension on your local PC via Chrome Native Messaging (`stdio`). It adjusts OS window styles (`WS_EX_LAYERED`, `WS_EX_TRANSPARENT`, `SetWindowPos`) for transparency, click-through, and cursor auto-dodge, and checks only whether your configured modifier keys (`Ctrl`, `Alt`, `Shift`) or global hotkeys are pressed. It makes **zero network connections** and never logs keystrokes.
- **No Third-Party Sharing or Analytics**: GhostPiP contains no analytics, telemetry, tracking scripts, advertisements, or external servers. No user data is ever sold or transferred to third parties.

**Contact**: For questions or issues, please use the Issue Tracker on the official GitHub repository or Chrome Web Store support page.

---

## 🇰🇷 한국어 (Korean)

**GhostPiP는 어떠한 개인정보나 방문 기록도 수집, 저장, 전송 또는 공유하지 않습니다.**

- **로컬 설정 저장 (`chrome.storage`)**: 투명도, 클릭 관통 여부, 자동 회피 모서리, 단축키, PiP 창의 크기와 위치 같은 사용자 설정값만 브라우저 내부의 `chrome.storage`에 저장합니다. 이 정보는 사용자 기기 안에만 남으며 외부로 전송되지 않습니다.
- **웹페이지 접근**: 영상 위에 런처 버튼을 표시하고 PiP 창을 생성·제어할 때만 현재 탭의 `<video>` 요소와 플레이어 영역을 참조합니다. 웹페이지 본문, 방문 기록, 입력값, 쿠키, 개인정보는 읽거나 저장하거나 전송하지 않습니다.
- **실시간 채팅 연동**: 전체 모드(Full Mode)에서 표시되는 채팅창은 해당 스트리밍 사이트(유튜브, 트위치, 치지직, SOOP/아프리카TV)의 공식 채팅 팝아웃 페이지를 그대로 띄운 것입니다. GhostPiP는 채팅 내용이나 계정 정보를 읽거나 수집하지 않습니다.
- **GhostPiP Engine (선택 설치형 로컬 도우미)**: 선택적으로 설치하는 `GhostPiP.Engine.exe`는 크롬과 표준 입출력(Chrome Native Messaging)으로만 통신하는 오프라인 로컬 프로그램입니다. PiP 창의 위치, 투명도, 클릭 관통을 조절하고 마우스 커서 위치 및 보조 키(`Ctrl`, `Alt`, `Shift`) 입력 여부만 실시간으로 확인하여 자동 회피를 처리합니다. 외부 네트워크에 전혀 접속하지 않으며 키보드 입력을 기록하지 않습니다.
- **제3자 제공 및 분석 도구 없음**: 제3자에게 데이터를 제공하거나 판매하지 않으며, 외부 분석 도구(Analytics)나 광고 SDK를 일체 사용하지 않습니다.

**문의**: 배포 페이지(GitHub 저장소 이슈 트래커 또는 크롬 웹 스토어 지원 탭)를 이용해 주세요.
