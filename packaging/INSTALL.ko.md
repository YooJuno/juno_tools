# Juno System Monitor 설치

지원 환경: **Ubuntu 24.04 / GNOME Shell 46**, X11 또는 Wayland.

## 권장: Ubuntu 설치 패키지(.deb)

Releases에서 `juno-system-monitor_버전_all.deb`를 내려받아 패키지 설치 앱으로 열거나, 파일이 있는 폴더에서 아래 명령으로 설치합니다.

```bash
sudo apt install ./juno-system-monitor_@VERSION@_all.deb
juno-system-monitor enable
```

그다음 X11은 **Alt+F2 → r → Enter**, Wayland는 로그아웃 후 다시 로그인합니다. 이후 로그인할 때마다 자동으로 표시됩니다.

이전에 ZIP 또는 소스 설치 스크립트로 설치했다면 사용자 설치가 시스템 패키지보다 우선합니다. `enable` 대신 아래 명령을 실행하세요. 기존 파일을 사용자 데이터 폴더에 백업한 뒤 시스템 패키지로 전환합니다.

```bash
juno-system-monitor migrate
```

설정은 앱 목록의 **Juno 시스템 모니터 설정** 또는 아래 명령으로 엽니다.

```bash
juno-system-monitor preferences
```

패키지 설치 과정은 사용자 홈이나 활성화 설정을 바꾸지 않습니다. `enable` 또는 `migrate`를 일반 사용자로 실행할 때만 활성화를 저장하며, 시스템 정책으로 잠긴 설정은 변경하지 않습니다. NVIDIA 드라이버를 자동 설치하거나 수정하지 않습니다.

## 대안: GNOME 확장 ZIP

관리자 권한 없이 현재 사용자에게 설치하려면 `system-monitor@juno-tools.shell-extension.zip`을 받으세요.

```bash
gnome-extensions install --force system-monitor@juno-tools.shell-extension.zip
```

X11에서 Shell을 재시작하거나 로그아웃/로그인한 뒤 실행합니다.

```bash
gnome-extensions enable system-monitor@juno-tools
```

사용자 확장이 전체적으로 꺼져 있으면 Extensions 앱에서 확장 사용을 켜세요. `.deb`와 ZIP 중 하나의 설치 방식을 사용하세요.

## 파일 검증

설치 파일과 함께 `SHA256SUMS`를 받은 뒤 같은 폴더에서 실행합니다.

```bash
sha256sum --ignore-missing -c SHA256SUMS
```

이 값은 파일 손상 여부를 확인하는 용도이며 별도 코드 서명은 아닙니다.

## 제거

`.deb` 설치를 제거하려면 아래 명령을 실행합니다. 사용자에게 저장된 설정과 이전 설치 백업은 유지합니다.

```bash
gnome-extensions disable system-monitor@juno-tools
sudo apt remove juno-system-monitor
```

ZIP으로 설치했다면 아래 명령을 사용합니다.

```bash
gnome-extensions disable system-monitor@juno-tools
gnome-extensions uninstall system-monitor@juno-tools
```
