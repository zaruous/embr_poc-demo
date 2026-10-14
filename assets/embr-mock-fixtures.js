/* embr-mock-fixtures.js — 목업(S-49 ~ S-57) 정적 예시 데이터 인라인 사본 (DC-03, MK-02 · MK-11)
   정본: ./mock/{offline,archive,iface}.mock.json — file:// 에서도 열리도록 같은 내용을 인라인 (tree-designer.js 선례).
   시험 check-mock-isolation.cjs 가 정본 JSON 과 이 사본의 JSON.stringify 동등을 확인한다. 직접 고치지 말고 JSON 과 함께 갱신.
   서명 필드 이름(…SignatureId(s)) 금지 — 서명 표시는 S-42 형식 문자열(signedText · reviewText)만. */
(function (global) {
  'use strict';
  global.EmbrMockFixtures = {
    "offline": {
      "v": 1,
      "area": "offline",
      "currentUser": {
        "userId": "OP-0101",
        "name": "작업자 A"
      },
      "scenarios": {
        "offline": {
          "label": "오프라인",
          "terminals": [
            {
              "termId": "T-MX-01",
              "room": "R-215",
              "line": "L-01",
              "conn": "OFFLINE",
              "lastSync": "2026-10-13 13:41:20",
              "buffer": 3,
              "signPending": 2,
              "clock": "none",
              "state": "warn"
            },
            {
              "termId": "T-CART-02",
              "room": "-",
              "line": "-",
              "conn": "OFFLINE",
              "lastSync": "-",
              "buffer": 0,
              "signPending": 0,
              "clock": "na",
              "state": "wait"
            },
            {
              "termId": "T-WB-01",
              "room": "R-201",
              "line": "L-01",
              "conn": "ONLINE",
              "lastSync": "2026-10-13 16:05:12",
              "buffer": 0,
              "signPending": 0,
              "clock": "none",
              "state": "ok"
            },
            {
              "termId": "T-GR-01",
              "room": "R-210",
              "line": "L-01",
              "conn": "ONLINE",
              "lastSync": "2026-10-13 16:04:57",
              "buffer": 0,
              "signPending": 0,
              "clock": "none",
              "state": "ok"
            }
          ],
          "buffer": {
            "T-MX-01": [
              {
                "seq": 1,
                "batchId": "BR-DEMO-0001",
                "step": "OP2-1",
                "item": "혼합 시간",
                "value": "12",
                "unit": "min",
                "at": "2026-10-13 13:52:08",
                "src": "OFFLINE",
                "proc": "동기화 대기"
              },
              {
                "seq": 2,
                "batchId": "BR-DEMO-0001",
                "step": "OP2-1",
                "item": "혼합 속도",
                "value": "18",
                "unit": "rpm",
                "at": "2026-10-13 13:52:40",
                "src": "OFFLINE",
                "proc": "동기화 대기"
              },
              {
                "seq": 3,
                "batchId": "BR-DEMO-0001",
                "step": "OP2-1",
                "item": "비고",
                "value": "정상",
                "unit": "",
                "at": "2026-10-13 13:55:02",
                "src": "OFFLINE",
                "proc": "동기화 대기"
              }
            ]
          },
          "conflicts": []
        },
        "reconnect": {
          "label": "재연결 직후(충돌 1)",
          "reconnectAt": "2026-10-13 14:20:05",
          "terminals": [
            {
              "termId": "T-MX-01",
              "room": "R-215",
              "line": "L-01",
              "conn": "ONLINE",
              "lastSync": "2026-10-13 14:20:05",
              "buffer": 3,
              "signPending": 2,
              "clock": "none",
              "state": "warn"
            },
            {
              "termId": "T-CART-02",
              "room": "-",
              "line": "-",
              "conn": "OFFLINE",
              "lastSync": "-",
              "buffer": 0,
              "signPending": 0,
              "clock": "na",
              "state": "wait"
            },
            {
              "termId": "T-WB-01",
              "room": "R-201",
              "line": "L-01",
              "conn": "ONLINE",
              "lastSync": "2026-10-13 16:05:12",
              "buffer": 0,
              "signPending": 0,
              "clock": "none",
              "state": "ok"
            },
            {
              "termId": "T-GR-01",
              "room": "R-210",
              "line": "L-01",
              "conn": "ONLINE",
              "lastSync": "2026-10-13 16:04:57",
              "buffer": 0,
              "signPending": 0,
              "clock": "none",
              "state": "ok"
            }
          ],
          "buffer": {
            "T-MX-01": [
              {
                "seq": 1,
                "batchId": "BR-DEMO-0001",
                "step": "OP2-1",
                "item": "혼합 시간",
                "value": "12",
                "unit": "min",
                "at": "2026-10-13 13:52:08",
                "src": "OFFLINE",
                "proc": "반영 가능"
              },
              {
                "seq": 2,
                "batchId": "BR-DEMO-0001",
                "step": "OP2-1",
                "item": "혼합 속도",
                "value": "18",
                "unit": "rpm",
                "at": "2026-10-13 13:52:40",
                "src": "OFFLINE",
                "proc": "충돌 - 감독자 확인"
              },
              {
                "seq": 3,
                "batchId": "BR-DEMO-0001",
                "step": "OP2-1",
                "item": "비고",
                "value": "정상",
                "unit": "",
                "at": "2026-10-13 13:55:02",
                "src": "OFFLINE",
                "proc": "반영 가능"
              }
            ]
          },
          "conflicts": [
            {
              "seq": 1,
              "item": "혼합 시간",
              "termValue": "12 min",
              "serverValue": "-",
              "verdict": "ok",
              "plan": "서버에 추가"
            },
            {
              "seq": 2,
              "item": "혼합 속도",
              "termValue": "18 rpm",
              "serverValue": "20 rpm",
              "verdict": "conflict",
              "plan": "감독자 확인 (자동 덮어쓰기 금지)"
            },
            {
              "seq": 3,
              "item": "비고",
              "termValue": "정상",
              "serverValue": "-",
              "verdict": "ok",
              "plan": "서버에 추가"
            }
          ]
        },
        "normal": {
          "label": "정상",
          "terminals": [
            {
              "termId": "T-MX-01",
              "room": "R-215",
              "line": "L-01",
              "conn": "ONLINE",
              "lastSync": "2026-10-13 16:05:30",
              "buffer": 0,
              "signPending": 0,
              "clock": "none",
              "state": "ok"
            },
            {
              "termId": "T-CART-02",
              "room": "-",
              "line": "-",
              "conn": "OFFLINE",
              "lastSync": "-",
              "buffer": 0,
              "signPending": 0,
              "clock": "na",
              "state": "wait"
            },
            {
              "termId": "T-WB-01",
              "room": "R-201",
              "line": "L-01",
              "conn": "ONLINE",
              "lastSync": "2026-10-13 16:05:12",
              "buffer": 0,
              "signPending": 0,
              "clock": "none",
              "state": "ok"
            },
            {
              "termId": "T-GR-01",
              "room": "R-210",
              "line": "L-01",
              "conn": "ONLINE",
              "lastSync": "2026-10-13 16:04:57",
              "buffer": 0,
              "signPending": 0,
              "clock": "none",
              "state": "ok"
            }
          ],
          "buffer": {},
          "conflicts": []
        }
      }
    },
    "archive": {
      "v": 1,
      "area": "archive",
      "packages": [
        {
          "pkgId": "ARC-2026-0007",
          "batchId": "BR-2026-0412",
          "finalizedAt": "2026-04-30",
          "retainUntil": "2029-05-31",
          "medium": "WORM-01",
          "pkgHash": "947a9c03cbc4765610bfc5f3149b1ecc3400b982a1e74c5c017adca8856e125d",
          "files": [
            {
              "name": "batch-record.pdf",
              "kind": "PDF/A-2b",
              "size": "1.8 MB",
              "recordedHash": "125321d18e9093ce60067de7eabfe0614633cdfb79912873974d1dd9ec7c50e9",
              "content": "{\"batchId\":\"BR-2026-0412\",\"ver\":1,\"kind\":\"mock-content\",\"part\":\"pdf-a-text-layer\",\"pages\":42}"
            },
            {
              "name": "data-package.json",
              "kind": "JSON",
              "size": "412 KB",
              "recordedHash": "851ee545dc0edcde7e1a11d08f3a58582f45e2b9862891039159726ff75a6610",
              "content": "{\"batchId\":\"BR-2026-0412\",\"ver\":1,\"kind\":\"mock-content\",\"part\":\"data\",\"steps\":18,\"values\":412}"
            },
            {
              "name": "audit-trail.json",
              "kind": "JSON",
              "size": "96 KB",
              "recordedHash": "c57468f89b27c7aa618370b9c3056f652f56ad35b5af87a5f6042fbb9b786237",
              "content": "{\"batchId\":\"BR-2026-0412\",\"ver\":1,\"kind\":\"mock-content\",\"part\":\"audit\",\"events\":960}"
            }
          ],
          "checks": [
            {
              "at": "2026-04-30",
              "kind": "이관 시 점검",
              "result": "pass"
            },
            {
              "at": "2026-10-01",
              "kind": "정기",
              "result": "pass"
            }
          ],
          "state": "kept",
          "nextCheck": "2027-01-01"
        },
        {
          "pkgId": "ARC-2026-0011",
          "batchId": "BR-2026-0533",
          "finalizedAt": "2026-06-12",
          "retainUntil": "2029-06-30",
          "medium": "WORM-01",
          "pkgHash": "3761813bb3aa46d90e5316d9542cc6511559c1235c134760c63ae0640af105f2",
          "files": [
            {
              "name": "batch-record.pdf",
              "kind": "PDF/A-2b",
              "size": "1.8 MB",
              "recordedHash": "be86118c97ddb856ae0cd6b97893b4c45ceb9e97ad47f70726aa723830d65f47",
              "content": "{\"batchId\":\"BR-2026-0533\",\"ver\":1,\"kind\":\"mock-content\",\"part\":\"pdf-a-text-layer\",\"pages\":42}"
            },
            {
              "name": "data-package.json",
              "kind": "JSON",
              "size": "412 KB",
              "recordedHash": "2dbc44447ed472cadb781cde05d45fe20aa3b55d64a29b98d213c98046c8a935",
              "content": "{\"batchId\":\"BR-2026-0533\",\"ver\":1,\"kind\":\"mock-content\",\"part\":\"data\",\"steps\":18,\"values\":412}"
            },
            {
              "name": "audit-trail.json",
              "kind": "JSON",
              "size": "96 KB",
              "recordedHash": "21327c6de6c66d93f54eadb63e213a53fef031cdc82e04fec5479e794f6c8265",
              "content": "{\"batchId\":\"BR-2026-0533\",\"ver\":1,\"kind\":\"mock-content\",\"part\":\"audit\",\"events\":960}"
            }
          ],
          "checks": [
            {
              "at": "2026-06-12",
              "kind": "이관 시 점검",
              "result": "pass"
            },
            {
              "at": "2026-10-01",
              "kind": "정기",
              "result": "pass"
            }
          ],
          "state": "kept",
          "nextCheck": "2027-01-01"
        },
        {
          "pkgId": "ARC-2026-0015",
          "batchId": "BR-2026-0601",
          "finalizedAt": "2026-07-20",
          "retainUntil": "2029-07-31",
          "medium": "WORM-02",
          "pkgHash": "031433e0980c66d1cd819c3a28bbd0a3003f89cfebdaf6ecab740d5f8393adcc",
          "files": [
            {
              "name": "batch-record.pdf",
              "kind": "PDF/A-2b",
              "size": "1.8 MB",
              "recordedHash": "dc662605f0489962901991e345e6960de826c271cc80bb821f8d66264467c7a6",
              "content": "{\"batchId\":\"BR-2026-0601\",\"ver\":1,\"kind\":\"mock-content\",\"part\":\"pdf-a-text-layer\",\"pages\":42}"
            },
            {
              "name": "data-package.json",
              "kind": "JSON",
              "size": "412 KB",
              "recordedHash": "e35ef96fc6c415ec0d841c9cc67218348a6f70f671670a6afe5198de1ea352f1",
              "content": "{\"batchId\":\"BR-2026-0601\",\"ver\":1,\"kind\":\"mock-content\",\"part\":\"data\",\"steps\":18,\"values\":412}"
            },
            {
              "name": "audit-trail.json",
              "kind": "JSON",
              "size": "96 KB",
              "recordedHash": "89d9e05da77cd0bd1162c033e396fb94dcd39d5561de337be9dade3601eca165",
              "content": "{\"batchId\":\"BR-2026-0601\",\"ver\":1,\"kind\":\"mock-content\",\"part\":\"audit\",\"events\":960}"
            }
          ],
          "checks": [
            {
              "at": "2026-07-20",
              "kind": "이관 시 점검",
              "result": "pass"
            },
            {
              "at": "2026-10-01",
              "kind": "정기 (시뮬)",
              "result": "fail"
            }
          ],
          "state": "error",
          "nextCheck": "2027-01-01"
        },
        {
          "pkgId": "ARC-2026-0019",
          "batchId": "BR-DEMO-0001",
          "finalizedAt": "",
          "retainUntil": "",
          "medium": "",
          "pkgHash": "",
          "files": [],
          "checks": [],
          "state": "wait",
          "nextCheck": ""
        }
      ],
      "checkSign": {
        "signedText": "확인 — 최민아(SV-0011) · SV · 2026-10-13 10:15 KST · Verified by",
        "exampleValue": true
      },
      "backups": [
        {
          "jobId": "BK-20261013-01",
          "kind": "일일 증분",
          "start": "2026-10-13 02:00:00",
          "end": "2026-10-13 02:07:41",
          "target": "eBR DB · 감사",
          "result": "ok",
          "verify": "건수 · hash 대조"
        },
        {
          "jobId": "BK-20261012-01",
          "kind": "일일 증분",
          "start": "2026-10-12 02:00:00",
          "end": "2026-10-12 02:06:55",
          "target": "eBR DB · 감사",
          "result": "ok",
          "verify": "건수 · hash 대조"
        },
        {
          "jobId": "BK-20261006-W",
          "kind": "주간 전체",
          "start": "2026-10-06 01:00:00",
          "end": "2026-10-06 01:48:12",
          "target": "전체",
          "result": "ok",
          "verify": "건수 · hash 대조"
        }
      ],
      "restoreTests": [
        {
          "testId": "RT-2026-Q3",
          "at": "2026-09-28",
          "env": "시험 환경 복원",
          "checks": "레코드 수 일치 · 감사 사슬 연속 · 서명 연결 유지",
          "result": "pass",
          "reviewText": "검토 — 이수진(QA-0011) · QA · 2026-10-13 09:30 KST · Reviewed by",
          "exampleValue": true
        }
      ]
    },
    "iface": {
      "v": 1,
      "area": "iface",
      "channels": [
        {
          "chId": "IF-ERP-ORD",
          "system": "ERP",
          "dir": "수신",
          "kind": "생산 오더",
          "ok": 12,
          "pending": 0,
          "dead": 0,
          "last": "16:02:10"
        },
        {
          "chId": "IF-ERP-GR",
          "system": "ERP",
          "dir": "송신",
          "kind": "생산 실적 · 입고",
          "ok": 9,
          "pending": 1,
          "dead": 0,
          "last": "15:58:44"
        },
        {
          "chId": "IF-LIMS-RES",
          "system": "LIMS",
          "dir": "수신",
          "kind": "시험 결과 · 판정",
          "ok": 5,
          "pending": 0,
          "dead": 1,
          "last": "15:40:03"
        },
        {
          "chId": "IF-QMS-DEV",
          "system": "QMS",
          "dir": "송신",
          "kind": "일탈 초안",
          "ok": 1,
          "pending": 0,
          "dead": 0,
          "last": "11:20:31"
        },
        {
          "chId": "IF-HIST-SNAP",
          "system": "Historian",
          "dir": "수신",
          "kind": "공정 값 스냅샷",
          "ok": 288,
          "pending": 0,
          "dead": 0,
          "last": "16:05:00"
        }
      ],
      "messages": [
        {
          "msgId": "MSG-LIMS-20261013-0005",
          "channel": "IF-LIMS-RES",
          "route": "LIMS > eBR",
          "at": "2026-10-13 15:40:03",
          "attempt": 1,
          "maxAttempt": 3,
          "target": "LOT LAC-2411",
          "checks": [
            {
              "key": "스키마 버전",
              "expected": "lims-result v2",
              "actual": "lims-result v2",
              "ok": true
            },
            {
              "key": "체크섬 SHA-256",
              "expected": "8d1e44c0 (헤더 값)",
              "actual": "8d1e44c0 (재계산)",
              "ok": true
            },
            {
              "key": "LOT · 시험 항목",
              "expected": "LAC-2411 · 수분",
              "actual": "LAC-2411 · 수분",
              "ok": true
            },
            {
              "key": "단위",
              "expected": "%",
              "actual": "mg/g",
              "ok": false
            }
          ],
          "raw": "{\"lot\":\"LAC-2411\",\"test\":\"LOD\",\"value\":42,\"unit\":\"mg/g\",\"judged\":\"PASS\",\"at\":\"2026-10-13T15:40:03+09:00\",\"src\":\"LIMS\",\"attempt\":1,\"schema\":\"lims-result v2\",\"checksum\":\"8d1e44c0b2a7f13e\",\"method\":\"LOD 105C 3h (USP <731>)\",\"spec\":{\"min\":0,\"max\":5,\"unit\":\"%\"},\"sample\":{\"id\":\"SMP-LAC-2411-03\",\"container\":\"C-07\",\"pulledAt\":\"2026-10-13T11:05:00+09:00\"},\"instrument\":\"MB-LAB-02 (예시)\",\"analysis\":{\"run\":\"RUN-20261013-118\",\"replicates\":[41.8,42.1,42.1],\"mean\":42},\"reviewer\":\"QC 검토 대기\",\"note\":\"원 시스템 단위 설정이 mg/g 로 바뀐 것으로 보임 - 자동 환산 금지 시연용 예시 원문 (목업)\",\"history\":[{\"at\":\"2026-10-13T15:40:03+09:00\",\"event\":\"RECEIVED\",\"by\":\"IF-LIMS-RES\"},{\"at\":\"2026-10-13T15:40:03+09:00\",\"event\":\"CHECK_FAILED\",\"detail\":\"unit expected % actual mg/g\"},{\"at\":\"2026-10-13T15:40:04+09:00\",\"event\":\"DEAD_LETTER\",\"queue\":\"DLQ-LIMS\"}],\"trace\":{\"correlationId\":\"COR-LIMS-7f3a9c21-0005\",\"sourceRecord\":\"LIMS-RES-2026-104455\",\"batchRef\":\"BR-DEMO-0001\"}}",
          "state": "dead",
          "reason": "단위 불일치",
          "owner": "QC 연동 담당자"
        },
        {
          "msgId": "MSG-LIMS-20261013-0004",
          "channel": "IF-LIMS-RES",
          "route": "LIMS > eBR",
          "at": "2026-10-13 14:12:51",
          "attempt": 1,
          "maxAttempt": 3,
          "target": "LOT MCC-2409",
          "checks": [
            {
              "key": "스키마 버전",
              "expected": "lims-result v2",
              "actual": "lims-result v2",
              "ok": true
            },
            {
              "key": "체크섬 SHA-256",
              "expected": "51f0a9d2 (헤더 값)",
              "actual": "51f0a9d2 (재계산)",
              "ok": true
            },
            {
              "key": "LOT · 시험 항목",
              "expected": "MCC-2409 · 수분",
              "actual": "MCC-2409 · 수분",
              "ok": true
            },
            {
              "key": "단위",
              "expected": "%",
              "actual": "%",
              "ok": true
            }
          ],
          "raw": "{\"lot\":\"MCC-2409\",\"test\":\"LOD\",\"value\":3.1,\"unit\":\"%\",\"judged\":\"PASS\",\"at\":\"2026-10-13T14:12:51+09:00\",\"src\":\"LIMS\",\"attempt\":1,\"schema\":\"lims-result v2\",\"checksum\":\"51f0a9d23c4e8b17\"}",
          "state": "applied",
          "reason": "",
          "owner": "QC 연동 담당자"
        }
      ],
      "recon": [
        {
          "batchId": "BR-DEMO-0001",
          "target": "ERP 실적",
          "label": "ERP 생산 실적",
          "rows": [
            {
              "item": "양품 수량",
              "ebr": 487200,
              "ext": 487200,
              "unit": "T"
            },
            {
              "item": "샘플 수량",
              "ebr": 2000,
              "ext": 2000,
              "unit": "T"
            },
            {
              "item": "입고 LOT",
              "ebr": "FG-2610-001",
              "ext": "FG-2610-001",
              "unit": ""
            },
            {
              "item": "폐기 수량",
              "ebr": 3100,
              "ext": 3000,
              "unit": "T"
            }
          ]
        },
        {
          "batchId": "BR-DEMO-0001",
          "target": "LIMS 판정",
          "label": "LIMS 시험 판정",
          "rows": [
            {
              "item": "수분 (LOD)",
              "ebr": "PASS",
              "ext": "PASS",
              "unit": ""
            },
            {
              "item": "함량",
              "ebr": "PASS",
              "ext": "PASS",
              "unit": ""
            },
            {
              "item": "붕해",
              "ebr": "PASS",
              "ext": "PASS",
              "unit": ""
            }
          ]
        }
      ],
      "reconSign": {
        "signedText": "검토 — 이수진(QA-0011) · QA · 2026-10-13 14:30 KST · Reviewed by",
        "exampleValue": true
      }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
