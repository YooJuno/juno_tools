# juno_tools

Ubuntu에서 사용하는 작은 도구 모음입니다.

## Juno System Monitor

Ubuntu 상단 패널의 **날짜/시계와 오른쪽 시스템 아이콘 사이**에 CPU, GPU, 메모리, 저장장치 상태를 표시하는 GNOME Shell 확장입니다.

![GNOME 46 테스트 세션에서 실제 센서값을 표시한 상단 패널](docs/topbar.png)

[밝은 테마의 상세 메뉴](docs/menu.png) · [어두운 테마의 상세 메뉴](docs/menu-dark.png) · [설정 화면](docs/settings.png)

상단에는 CPU 칩, GPU 보드, 메모리 모듈, SSD를 나타내는 **20px 아이콘과 사용률**만 표시합니다. 아이콘은 채움 도형으로 그려 밝은 패널과 어두운 패널에서 윤곽이 선명하게 보입니다. 항목 이름 대신 아이콘을 사용하고 간격을 줄여 패널 공간을 아꼈습니다. 스크린 리더에는 각 항목의 이름과 현재 수치를 제공합니다.

클릭 메뉴는 **CPU·GPU·Memory·Storage 네 구역**으로 구성합니다. 각 구역에서 사용률을 먼저 보여주고, 아래에 온도나 용량 등의 보조 정보를 모아 표시합니다. 긴 GPU 이름은 말줄임 처리합니다. 메뉴 글자와 아이콘은 GNOME 테마의 전경색을 따라 밝은 테마와 어두운 테마에 맞게 표시됩니다.

지원 환경: **Ubuntu 24.04 / GNOME Shell 46**, X11 및 Wayland. 실제 동작 검증은 GNOME 46에서 수행했습니다. 다른 GNOME 버전은 호환성을 확인한 뒤 추가할 예정입니다.

| 항목 | 상단 패널 | 클릭 메뉴 |
| --- | --- | --- |
| CPU 칩 아이콘 | 전체 CPU 사용률 | 사용률, CPU 센서의 최고 온도 |
| GPU 보드 아이콘 | 선택한 GPU의 사용률 | GPU 이름, VRAM 사용량, 온도 |
| 메모리 모듈 아이콘 | 실제 사용 중인 RAM 비율 | 사용량/전체 용량, 스왑 |
| SSD 아이콘 | 선택 경로가 속한 파일시스템의 용량 사용률 | 사용량/전체 용량, 여유 공간, 읽기·쓰기 속도, I/O 활동률 |

사용률 75% 이상은 노란색, 90% 이상은 빨간색으로 표시합니다. 첫 CPU/I/O 샘플과 지원하지 않는 센서는 `—`로 표시합니다. CPU 온도는 Intel `coretemp`, AMD `k10temp`/`zenpower`, CPU용 hwmon 센서와 Linux CPU thermal zone에서 읽습니다. v0.5.1부터 Jetson Thor의 `cpu-thermal`도 탐색하며, GPU·SoC·보드·접합 최고 온도(`tj-thermal`)를 CPU 온도로 대신 표시하지 않습니다.

### 설치

Releases에서 **Ubuntu 설치 패키지(.deb)** 또는 **GNOME 확장 ZIP**을 받을 수 있습니다.

- [최신 설치 파일](https://github.com/YooJuno/juno_tools/releases/latest)
- `.deb`: 패키지 설치 앱으로 열거나 `sudo apt install ./juno-system-monitor_0.5.3_all.deb`로 설치합니다. 이후 일반 사용자로 `juno-system-monitor enable`을 실행합니다.
- 기존 ZIP/소스 설치에서 `.deb`로 전환할 때는 `juno-system-monitor migrate`를 실행합니다. 기존 설치를 백업하고 사용자 설정은 유지합니다.
- X11은 Alt+F2 → r → Enter, Wayland는 로그아웃/로그인 후 표시됩니다.
- 앱 목록의 **Juno 시스템 모니터 설정** 또는 `juno-system-monitor preferences`로 설정을 엽니다.

인터넷이 연결된 다른 PC의 GNOME 데스크톱 터미널에서는 아래 명령으로 설치하거나 업데이트할 수 있습니다. ARM64용 Ubuntu 24.04에서도 같은 패키지를 사용합니다.

```bash
wget -O juno-system-monitor_0.5.3_all.deb \
  https://github.com/YooJuno/juno_tools/releases/download/v0.5.3/juno-system-monitor_0.5.3_all.deb &&
sudo apt install ./juno-system-monitor_0.5.3_all.deb &&
juno-system-monitor enable
```

설치 후 로그아웃/로그인하면 새 코드가 적용됩니다. 기존 `.deb` 업데이트도 이 절차를 사용하며 설정을 유지합니다.

아래는 소스에서 직접 설치하는 방법입니다. `.deb`와 사용자 ZIP/소스 설치 중 한 방식을 사용하세요.

기본 Ubuntu GNOME 환경에서 관리자 권한 없이 설치합니다.

```bash
git clone https://github.com/YooJuno/juno_tools.git
cd juno_tools
bash gnome-system-monitor/install.sh --enable
```

`--enable`은 이 확장의 활성화 상태를 저장하고, 사용자 확장 전체가 꺼져 있으면 함께 켭니다. 다른 확장의 개별 활성화/비활성화 목록은 유지합니다.

GNOME의 설치 금지 정책과 설정 잠금을 확인합니다. 요청한 설정을 저장할 수 없으면 성공으로 표시하지 않습니다. 업데이트는 별도 디렉터리에서 검증한 뒤 교체하며, 교체 실패 시 기존 설치를 복구합니다. 기존 설치의 추가 파일은 보존합니다.

처음 설치한 확장을 GNOME이 아직 인식하지 못하면 **로그아웃 후 다시 로그인**하세요. 활성화 설정이 저장되어 있으므로 자동으로 표시됩니다. 이후 재부팅할 때도 우분투에 로그인하면 자동으로 시작합니다. 업데이트도 설치 스크립트를 다시 실행한 뒤 로그아웃/로그인하면 새 코드가 로드됩니다.

`--enable` 없이 설치한 경우에는 로그아웃/로그인 후 직접 활성화합니다.

```bash
gnome-extensions enable system-monitor@juno-tools
```

`--enable` 없이 설치했고 확장이 전체적으로 꺼져 있으면 Extensions 앱에서 확장 사용도 켜야 합니다. 필요한 명령이 없는 최소 설치 환경에서는 `gnome-shell`, `gjs`, `libglib2.0-bin` 패키지가 필요합니다.

ZIP으로 설치하려면 아래의 패키징 명령으로 ZIP을 생성한 뒤 설치합니다.

```bash
bash gnome-system-monitor/pack.sh
bash packaging/build-release.sh
bash tests/deb-package.sh
gnome-extensions install --force dist/system-monitor@juno-tools.shell-extension.zip
```

이후 처음 설치한 경우 로그아웃/로그인하고 위의 enable 명령을 실행하세요.

### 설정

상단 표시를 클릭한 뒤 **Settings…**를 선택하거나 아래 명령을 실행합니다.

```bash
gnome-extensions prefs system-monitor@juno-tools
```

- 갱신 주기: 기본 2초, 1~30초.
- CPU/GPU/MEM/SSD 표시를 개별적으로 켜고 끌 수 있습니다. 모두 끄면 설정 아이콘만 남기고 백그라운드 수집과 주기 타이머를 멈춥니다. 상세 메뉴를 열 때만 필요한 센서를 읽습니다.
- 메뉴가 닫혀 있으면 숨긴 CPU/RAM/SSD 센서를 읽지 않습니다. 상세 메뉴를 열면 필요한 센서를 수집합니다. GPU 표시를 끄면 메뉴 상태와 관계없이 GPU 조회를 중단합니다.
- 닫힌 메뉴에서는 온도·디스크 I/O를 조회하지 않습니다. SSD 용량은 메뉴를 열 때 한 번 최신 조회한 뒤 최대 10초 캐시하고, 상세 메뉴의 디스크 I/O는 설정 주기마다 갱신합니다. CPU 온도는 5초, 마운트 매핑은 30초 캐시합니다.
- 저장 경로: 기본 `/`. `/home`, `/mnt/data` 등 실제 경로를 입력하고 적용 버튼을 누릅니다. 경로는 비동기로 확인하며, 검증 실패·시간 초과·창 닫기 시 기존 설정을 유지합니다. 별도 파티션이 아니라면 `/`와 같은 용량이 표시됩니다.
- GPU 인덱스: 기본 `0`. 처음 발견할 때 NVIDIA 다음 AMD 순서로 슬롯을 만들고, 이후 발견한 장치는 뒤에 추가합니다. 한 세션 동안 슬롯을 유지하며, 연결 해제·드라이버 실패 시 다른 GPU 값으로 대체하지 않고 `—`로 표시합니다. NVIDIA는 UUID, AMD는 제공되는 경우 PCI 주소로 식별합니다.

### 센서와 제한

- CPU/RAM은 `/proc`에서, 온도/AMD GPU는 `/sys`에서 읽습니다. 비동기 I/O를 사용하며 별도 서비스 설치나 root 권한이 필요하지 않습니다.
- v0.5.3부터 일부 센서가 늦어지면 완료된 센서 결과를 먼저 표시합니다. 대기 중인 항목은 기존 수치 또는 로딩 표시를 유지하고 `reading…`으로 구분합니다. 빠른 수집은 한 번만 화면에 반영합니다. 설정 변경·비활성화 뒤의 늦은 결과는 무시하며, 센서 주기·시간 제한·동시 작업 수는 늘리지 않습니다.
- CPU thermal zone은 `type`이 `cpu-thermal`, `CPU-therm`, `cpu_thermal`, `x86_pkg_temp`인 센서만 사용합니다. 센서 번호에 의존하지 않으며, 센서 탐색은 60초·온도는 5초 캐시하고 메뉴를 닫으면 조회하지 않습니다. 읽을 수 없거나 잘못된 값은 `—`로 표시합니다.
- Jetson Thor / JetPack 7.2.1 사용자의 v0.5.0 화면에서 GPU 사용률·GPU 온도·CPU/RAM/저장장치 사용률이 표시되는 것을 확인했습니다. CPU 온도 누락은 v0.5.1에서 thermal-zone 탐색으로 수정했습니다. Thor 센서 배치를 재현한 회귀 검사와 PC 실센서 검사를 수행했으며, 수정본의 Thor 실기기 온도 표시는 아직 확인하지 않았습니다. 센서 정의는 [NVIDIA Thor thermal zone 문서](https://docs.nvidia.com/jetson/archives/r39.2.1/DeveloperGuide/SD/PlatformPowerAndPerformance/JetsonThor.html#bsp-specific-thermal-zones)를 따릅니다. GPU 전용 메모리는 드라이버에서 제공하지 않으면 `—`로 표시합니다.
- NVIDIA는 드라이버가 제공하는 `nvidia-smi`가 필요합니다. 현재 PC의 RTX 4060 Laptop GPU에서 확인했습니다. AMD는 `amdgpu`의 `gpu_busy_percent` 및 VRAM sysfs 센서가 있는 경우 사용률/VRAM을 읽으며, 실장치 검증은 아직 수행하지 않았습니다. AMD 온도 및 Intel GPU 사용률은 현재 제공하지 않습니다.
- NVIDIA는 GPU 표시가 켜진 동안 `nvidia-smi` 프로세스 하나의 반복 조회를 재사용합니다. 매 갱신마다 프로세스와 NVML을 초기화하던 비용을 줄입니다. 이 PC에서 해당 프로세스의 메모리는 약 23 MiB였습니다. GPU 표시를 끄거나 확장을 종료하면 프로세스도 종료합니다.
- NVIDIA 조회는 노트북의 외장 GPU 절전에 영향을 줄 수 있습니다. 첫 응답은 3초 제한을 두며, 응답이 멈추면 프로세스를 종료하고 30초 뒤 재시도합니다. 오래된 GPU 값을 정상 값처럼 계속 표시하지 않습니다.
- MEM은 `(MemTotal - MemAvailable) / MemTotal`입니다. 재사용할 수 있는 캐시를 모두 사용 메모리로 계산하지 않습니다.
- SSD 아이콘의 수치는 드라이브 종류와 관계없이 **선택한 파일시스템의 용량 사용률**입니다. I/O 속도와 활동률은 해당 마운트의 블록 장치 카운터를 읽습니다. 네트워크/가상 파일시스템처럼 대응하는 블록 장치가 없으면 I/O는 `—`입니다. SMART 수명/고장 예측은 수집하지 않습니다.
- 센서 하나가 실패해도 나머지 지표는 계속 갱신됩니다. 없는 값을 0%로 오인하지 않도록 `—`로 표시합니다.
- 심볼릭 링크로 지정한 저장 경로는 실제 파일시스템의 장치 번호로 I/O 대상을 선택합니다. 장치 변경·카운터 초기화 뒤에는 기준 샘플을 다시 잡습니다.

성능 점검 결과와 측정 방법은 [성능·안정성 검토](docs/performance.md)에 정리했습니다.

추가로 발견한 비동기·설치·설정 정책 문제와 검증 내용은 [전체 흐름 재검토](docs/full-audit.md)에 정리했습니다.

### 비활성화 및 삭제

```bash
gnome-extensions disable system-monitor@juno-tools
gnome-extensions uninstall system-monitor@juno-tools
```

### 개발 및 검증

런타임은 GJS이며 외부 npm 라이브러리는 없습니다. Node.js는 계산·파서·갱신 일정 테스트에만 사용합니다.

```bash
npm test
gjs -m tests/collector-smoke.js
gjs -m tests/monitor-regression.js
gjs -m tests/nvidia-regression.js
gjs -m tests/activation-regression.js
glib-compile-schemas --strict gnome-system-monitor/schemas
bash -n gnome-system-monitor/install.sh gnome-system-monitor/pack.sh
bash tests/installer-smoke.sh
bash gnome-system-monitor/pack.sh
```

센서 테스트는 실제 `/proc`와 `/sys`를 읽고, 잘못된 경로에 대한 오류 격리 및 수집 도중 취소도 확인합니다. GitHub Actions에서 이 검사와 설치 ZIP 생성을 수행합니다.

회귀 테스트는 느린 파일시스템의 작업 누적 방지, 숨긴 센서 생략, 장치 변경, GPU 프로세스 재사용·응답 중단·종료·취소를 검사합니다. 성능 측정은 CI 통과 기준으로 사용하지 않습니다.

설치 테스트는 격리된 설정 저장소에서 첫 로그인 전 활성화 저장, 기존 확장 설정 보존, 반복 설치를 확인합니다.

GNOME 46의 별도 Wayland 테스트 세션에서 상단 위치, 상세 메뉴, 설정 화면, GPU 표시/조회 중단, 갱신 주기 변경, 비활성화 및 재활성화를 확인했습니다. 위 스크린샷은 이 세션에서 실제 하드웨어 값을 읽어 캡처했습니다.

구현 참고: [GNOME 확장 개발](https://gjs.guide/extensions/development/creating.html), [GNOME 설정](https://gjs.guide/extensions/development/preferences.html), [Linux I/O 통계](https://kernel.org/doc/html/next/admin-guide/iostats.html), [NVIDIA SMI](https://docs.nvidia.com/deploy/nvidia-smi/index.html).
