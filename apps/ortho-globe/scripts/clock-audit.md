# 世界時計 段 0：国 × NE の時間帯の面（2026-10-13）

格子 0.5°・admin0 50m × NE 10m time zones・標準時は 2026 年の 1 月と 7 月の小さい方（tzdata＝2025b）。生成＝scripts/clock-audit.mjs。

- 組 279（国 186）。決め方：country 187・override 14・ne-name 17・offset 25・nearest 4・ne-offset 0・antarctica 32・none 0
- NE の面の差（2012）と決まった名前の今の標準時が食い違う組 39（＝NE が古い所。決まった名前が正しいので時刻は正しい）
- 手直しの表（OVERRIDE）が直す組 14

## 食い違う組（NE ≠ 今）

| 国 | NE の面 | NE の名前 | 決まった名前 | 決め方 | 今の標準時 | 点 |
|---|---|---|---|---|---|---|
| Benin (BEN) | UTC | Europe/Lisbon | Africa/Porto-Novo | country | UTC+1 | 1 |
| Burkina Faso (BFA) | UTC+1 | Europe/Paris | Africa/Ouagadougou | country | UTC | 1 |
| Bangladesh (BGD) | UTC+5:30 | Asia/Kolkata | Asia/Dhaka | country | UTC+6 | 1 |
| Belarus (BLR) | UTC+2 | Europe/Mariehamn | Europe/Minsk | country | UTC+3 | 1 |
| People's Republic of China (CHN) | UTC+5:45 | Asia/Kathmandu | Asia/Shanghai | country | UTC+8 | 1 |
| People's Republic of China (CHN) | UTC+6 | Asia/Almaty | Asia/Shanghai | country | UTC+8 | 1 |
| People's Republic of China (CHN) | UTC+6:30 | Asia/Rangoon | Asia/Shanghai | country | UTC+8 | 1 |
| Democratic Republic of the Congo (COD) | UTC+3 | Asia/Riyadh | Africa/Lubumbashi | nearest | UTC+2 | 1 |
| Falkland Islands (FLK) | UTC−4 | America/La_Paz | Atlantic/Stanley | country | UTC−3 | 6 |
| Greenland (GRL) | UTC−3 | America/Sao_Paulo | America/Nuuk | nearest | UTC−2 | 2523 |
| Greenland (GRL) | UTC−1 | America/Scoresbysund | America/Scoresbysund | ne-name | UTC−2 | 17 |
| Jordan (JOR) | UTC+2 | Europe/Mariehamn | Asia/Amman | country | UTC+3 | 33 |
| Kazakhstan (KAZ) | UTC+6 | Asia/Almaty | Asia/Almaty | country | UTC+5 | 968 |
| Kazakhstan (KAZ) | UTC+7 | Asia/Omsk | Asia/Almaty | country | UTC+5 | 2 |
| Kazakhstan (KAZ) | UTC+8 | Australia/Perth | Asia/Almaty | country | UTC+5 | 1 |
| Morocco (MAR) | UTC | Europe/Lisbon | Africa/Casablanca | country | UTC+1 | 224 |
| Myanmar (MMR) | UTC+5:30 | Asia/Kolkata | Asia/Yangon | country | UTC+6:30 | 1 |
| Namibia (NAM) | UTC+1 | Europe/Paris | Africa/Windhoek | country | UTC+2 | 281 |
| Paraguay (PRY) | UTC−4 | America/La_Paz | America/Asuncion | country | UTC−3 | 139 |
| Russia (RUS) | UTC+3 | Europe/Kaliningrad | Europe/Kaliningrad | override | UTC+2 | 7 |
| Russia (RUS) | UTC+4 | Europe/Moscow | Europe/Moscow | override | UTC+3 | 2252 |
| Russia (RUS) | UTC+6 | Asia/Almaty | Asia/Yekaterinburg | override | UTC+5 | 1480 |
| Russia (RUS) | UTC+8 | Australia/Perth | Asia/Krasnoyarsk | override | UTC+7 | 2095 |
| Russia (RUS) | UTC+9 | Asia/Irkutsk | Asia/Irkutsk | override | UTC+8 | 647 |
| Russia (RUS) | UTC+10 | Asia/Yakutsk | Asia/Yakutsk | override | UTC+9 | 2075 |
| Russia (RUS) | UTC+11 | Asia/Vladivostok | Asia/Vladivostok | override | UTC+10 | 640 |
| Russia (RUS) | UTC+11 |  | Asia/Vladivostok | override | UTC+10 | 245 |
| Western Sahara (SAH) | UTC | Europe/Lisbon | Africa/El_Aaiun | country | UTC+1 | 29 |
| Sudan (SDN) | UTC+3 | Asia/Riyadh | Africa/Khartoum | country | UTC+2 | 627 |
| South Sudan (SDS) | UTC+3 | Asia/Riyadh | Africa/Juba | country | UTC+2 | 202 |
| Syria (SYR) | UTC+2 | Europe/Mariehamn | Asia/Damascus | country | UTC+3 | 76 |
| Turkmenistan (TKM) | UTC+4:30 | Asia/Kabul | Asia/Ashgabat | country | UTC+5 | 1 |
| Turkey (TUR) | UTC+2 | Europe/Mariehamn | Europe/Istanbul | country | UTC+3 | 319 |
| Ukraine (UKR) | UTC+4 | Europe/Moscow | Europe/Simferopol | nearest | UTC+3 | 1 |
| United States of America (USA) | UTC−4 | America/La_Paz | America/New_York | nearest | UTC−5 | 1 |
| Venezuela (VEN) | UTC−4:30 | America/Caracas | America/Caracas | country | UTC−4 | 298 |
| South Africa (ZAF) | UTC+1 | Europe/Paris | Africa/Johannesburg | country | UTC+2 | 1 |
| South Africa (ZAF) | UTC+3 | Asia/Riyadh | Africa/Johannesburg | country | UTC+2 | 1 |
| Zambia (ZMB) | UTC+3 | Asia/Riyadh | Africa/Lusaka | country | UTC+2 | 1 |

## 時間帯が複数ある国の組（決め方が country 以外）

| 国 | NE の面 | NE の名前 | 決まった名前 | 決め方 | 点 |
|---|---|---|---|---|---|
| Australia (AUS) | UTC+8 | Australia/Perth | Australia/Perth | ne-name | 900 |
| Australia (AUS) | UTC+8:45 | Australia/Eucla | Australia/Eucla | ne-name | 2 |
| Australia (AUS) | UTC+9:30 | Australia/Adelaide | Australia/Adelaide | ne-name | 830 |
| Australia (AUS) | UTC+10 | Australia/Sydney | Australia/Sydney | ne-name | 1044 |
| Brazil (BRA) | UTC−4 | America/La_Paz | America/Campo_Grande | offset | 1145 |
| Brazil (BRA) | UTC−3 | America/Sao_Paulo | America/Sao_Paulo | ne-name | 1688 |
| Canada (CAN) | UTC−8 | America/Los_Angeles | America/Vancouver | offset | 823 |
| Canada (CAN) | UTC−7 | America/Denver | America/Edmonton | offset | 2045 |
| Canada (CAN) | UTC−6 | America/Chicago | America/Winnipeg | offset | 1505 |
| Canada (CAN) | UTC−5 | America/New_York | America/Toronto | offset | 2083 |
| Canada (CAN) | UTC−4 | America/La_Paz | America/Halifax | offset | 230 |
| Canada (CAN) | UTC−3:30 | America/St_Johns | America/St_Johns | ne-name | 62 |
| Chile (CHL) | UTC−4 | America/La_Paz | America/Santiago | offset | 298 |
| Democratic Republic of the Congo (COD) | UTC+1 | Europe/Paris | Africa/Kinshasa | offset | 246 |
| Democratic Republic of the Congo (COD) | UTC+2 | Africa/Johannesburg | Africa/Lubumbashi | offset | 509 |
| Democratic Republic of the Congo (COD) | UTC+3 | Asia/Riyadh | Africa/Lubumbashi | nearest | 1 |
| Ecuador (ECU) | UTC−6 | America/Chicago | Pacific/Galapagos | offset | 2 |
| Ecuador (ECU) | UTC−5 | America/New_York | America/Guayaquil | offset | 78 |
| Spain (ESP) | UTC | Europe/Lisbon | Atlantic/Canary | offset | 3 |
| Spain (ESP) | UTC+1 | Europe/Paris | Europe/Madrid | offset | 212 |
| France (FRA) | UTC−3 | America/Sao_Paulo | America/Cayenne | override | 26 |
| France (FRA) | UTC+3 | Asia/Riyadh | Indian/Mayotte | override | 1 |
| Greenland (GRL) | UTC−4 | America/La_Paz | America/Thule | offset | 59 |
| Greenland (GRL) | UTC−3 | America/Sao_Paulo | America/Nuuk | nearest | 2523 |
| Greenland (GRL) | UTC−1 | America/Scoresbysund | America/Scoresbysund | ne-name | 17 |
| Greenland (GRL) | UTC | America/Danmarkshavn | America/Danmarkshavn | ne-name | 37 |
| Indonesia (IDN) | UTC+7 | Asia/Jakarta | Asia/Jakarta | ne-name | 290 |
| Indonesia (IDN) | UTC+8 | Australia/Perth | Asia/Makassar | offset | 162 |
| Indonesia (IDN) | UTC+9 | Asia/Tokyo | Asia/Jayapura | offset | 158 |
| Mexico (MEX) | UTC−8 | America/Los_Angeles | America/Tijuana | offset | 30 |
| Mexico (MEX) | UTC−7 | America/Denver | America/Mazatlan | override | 210 |
| Mexico (MEX) | UTC−6 | America/Chicago | America/Mexico_City | offset | 457 |
| Mongolia (MNG) | UTC+7 | Asia/Omsk | Asia/Hovd | offset | 89 |
| Mongolia (MNG) | UTC+8 | Australia/Perth | Asia/Ulaanbaatar | offset | 648 |
| New Zealand (NZL) | UTC+12 | Pacific/Auckland | Pacific/Auckland | ne-name | 116 |
| Papua New Guinea (PNG) | UTC+10 | Australia/Sydney | Pacific/Port_Moresby | offset | 152 |
| Portugal (PRT) | UTC | Europe/Lisbon | Europe/Lisbon | ne-name | 36 |
| Russia (RUS) | UTC+2 | Europe/Mariehamn | Europe/Kaliningrad | offset | 12 |
| Russia (RUS) | UTC+2 | Europe/Helsinki | Europe/Kaliningrad | offset | 1 |
| Russia (RUS) | UTC+3 | Europe/Kaliningrad | Europe/Kaliningrad | override | 7 |
| Russia (RUS) | UTC+4 | Europe/Moscow | Europe/Moscow | override | 2252 |
| Russia (RUS) | UTC+5 | Asia/Tashkent | Asia/Yekaterinburg | offset | 2 |
| Russia (RUS) | UTC+6 | Asia/Almaty | Asia/Yekaterinburg | override | 1480 |
| Russia (RUS) | UTC+7 | Asia/Omsk | Asia/Novosibirsk | override | 561 |
| Russia (RUS) | UTC+8 | Australia/Perth | Asia/Krasnoyarsk | override | 2095 |
| Russia (RUS) | UTC+9 | Asia/Irkutsk | Asia/Irkutsk | override | 647 |
| Russia (RUS) | UTC+10 | Asia/Yakutsk | Asia/Yakutsk | override | 2075 |
| Russia (RUS) | UTC+11 | Asia/Vladivostok | Asia/Vladivostok | override | 640 |
| Russia (RUS) | UTC+11 |  | Asia/Vladivostok | override | 245 |
| Russia (RUS) | UTC+12 | Asia/Kamchatka | Asia/Kamchatka | override | 1576 |
| Russia (RUS) | UTC+12 | Asia/Kamchatka | Asia/Kamchatka | override | 95 |
| Ukraine (UKR) | UTC+2 | Europe/Mariehamn | Europe/Kyiv | offset | 281 |
| Ukraine (UKR) | UTC+4 | Europe/Moscow | Europe/Simferopol | nearest | 1 |
| United States of America (USA) | UTC−10 | Pacific/Honolulu | Pacific/Honolulu | ne-name | 7 |
| United States of America (USA) | UTC−9 | America/Anchorage | America/Anchorage | ne-name | 1102 |
| United States of America (USA) | UTC−8 | America/Los_Angeles | America/Los_Angeles | ne-name | 489 |
| United States of America (USA) | UTC−7 | America/Denver | America/Denver | ne-name | 908 |
| United States of America (USA) | UTC−6 | America/Chicago | America/Chicago | ne-name | 1232 |
| United States of America (USA) | UTC−5 | America/New_York | America/New_York | ne-name | 692 |
| United States of America (USA) | UTC−4 | America/La_Paz | America/New_York | nearest | 1 |
