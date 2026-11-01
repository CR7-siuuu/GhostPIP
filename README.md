# GhostPiP

화면을 가리지 않는 PiP. 영상 창을 투명하게 하거나 클릭이 뒤로 통과하게 만들고, 마우스가 다가오면 다른 모서리로 비켜 줍니다.

- **웹 모드**: 브라우저 탭 안에 떠 있는 창입니다. 탭을 옮겨도 따라옵니다. 확장만 있으면 됩니다.
- **전체 모드**: 게임이나 다른 프로그램 위에 뜨는 Document PiP 창입니다. 투명도, 클릭 통과, 자동 회피를 쓰려면 Windows용 GhostPiP Engine이 필요합니다.

지원 사이트: 유튜브, 치지직, SOOP, 트위치. 팝업의 "모든 사이트에서 사용"을 켜 두면 다른 사이트의 일반 동영상 플레이어에서도 동작합니다. GIF처럼 소리 없이 반복 재생되는 짧은 영상은 대상에서 빠집니다.

## 설치

1. `npm run build:zip`을 실행하면 `dist/`에 아래 세 파일이 생깁니다.
   - `GhostPiP-Full-Package.zip`: 확장 + 엔진 + README (사용자 배포용)
   - `GhostPiP-Extension-store.zip`: Chrome 웹 스토어 업로드용. `key`와 `_metadata`를 뺀 버전입니다.
   - `GhostPiP-Engine-win-x64.zip`: 엔진만 들어 있습니다.
2. 확장: `chrome://extensions`에서 개발자 모드를 켜고 `extension` 폴더를 로드합니다.
3. 엔진: `engine\install.bat`을 실행합니다. 엔진은 `%LOCALAPPDATA%\Programs\GhostPiP`에 복사되고 Chrome, Edge, Whale, Brave에 네이티브 메시징 호스트로 등록됩니다. 관리자 권한은 필요 없습니다. 제거는 `uninstall.bat`입니다.

## 조작

| 동작 | 방법 |
|---|---|
| 이동 / 크기 조절 | 보조 키(기본 `Ctrl+Alt`)를 누른 채 드래그 / 가장자리 드래그 |
| 투명도 | 보조 키 + 휠 |
| 클릭 통과 | `Alt+G` |
| 자동 회피 | `Alt+Shift+D` |
| 음소거 | `Alt+M` |

## 백신 오탐과 코드 서명

엔진은 다른 프로세스의 창(PiP 창)을 자기 창 안에 넣어 위치와 투명도를 바꾸고, 저수준 마우스 훅으로 입력을 전달합니다. 서명되지 않은 신규 실행 파일이 이런 동작을 하면 일부 백신이 범용 휴리스틱으로 오탐합니다(예: Avast `Win64:Evo-gen [Trj]`). 엔진은 네트워크에 접속하지 않고 파일도 수집하지 않습니다. 통신은 크롬과의 stdin/stdout 네이티브 메시징뿐입니다.

배포 전 처리:

1. **코드 서명**: 서명하면 대부분 해결됩니다. 아래 둘 중 하나를 설정하고 `npm run build:zip`을 실행하면 `signtool`로 서명과 타임스탬프까지 처리합니다.
   - `GHOSTPIP_SIGN_THUMBPRINT`: 현재 사용자 인증서 저장소에 있는 코드 서명 인증서의 지문
   - `GHOSTPIP_SIGN_PFX` (필요하면 `GHOSTPIP_SIGN_PFX_PASSWORD`도 함께)
   - 타임스탬프 서버를 바꾸려면 `GHOSTPIP_SIGN_TIMESTAMP_URL`
2. **오탐 신고**: 서명된 빌드를 아래 양식으로 제출합니다.
   - Avast/AVG: https://www.avast.com/false-positive-file-form.php
   - Microsoft Defender: https://www.microsoft.com/wdsi/filesubmission
3. 사용자에게는 격리 복원 후 `%LOCALAPPDATA%\Programs\GhostPiP`를 예외에 추가하라고 안내합니다. 같은 안내가 확장 안내 페이지(`guide/guide.html`)와 README.txt에도 들어 있습니다.

## Chrome 웹 스토어 게시

- `GhostPiP-Extension-store.zip`을 업로드합니다.
- 스토어가 부여한 확장 ID를 `engine/installer/install.ps1`의 `$DefaultExtensionIds`에 추가한 뒤 엔진 패키지를 다시 빌드합니다. 이 ID가 없으면 스토어판 확장이 엔진에 연결할 수 없습니다.
- 개인정보 처리방침은 [PRIVACY.md](PRIVACY.md)를 사용하세요.
- 권한 사유:
  - `nativeMessaging`: 로컬 엔진과 통신
  - `scripting`, 모든 사이트 호스트 권한: 일반 사이트 동영상에 오버레이 표시
  - `declarativeNetRequest`: 채팅 팝아웃 페이지를 PiP 창 안 iframe으로 띄우기 위해 해당 채팅 URL의 프레임 차단 헤더만 제거
  - `storage`: 설정 저장

## 개발

```powershell
npm install
powershell -File scripts/build-res.ps1   # engine/GhostPiP.Engine.rc를 바꿨을 때만
npm run build:zip
npm run test:unit
node test/e2e/popup.mjs
node test/e2e/generic.mjs
node test/e2e/engine.mjs      # 엔진 빌드 필요
node test/e2e/crosstab.mjs
node test/e2e/run.mjs youtube
```
