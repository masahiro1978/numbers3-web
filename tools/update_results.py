#!/usr/bin/env python3
"""Update public Numbers 3 facts from two official bank sources.

One request is sent to each source.  Access restrictions are never retried or
bypassed.  The output is replaced only when overlapping draw/date/number facts
match and the verified latest draw advances.
"""
from __future__ import annotations

import csv
import html
import io
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data/results.json"
PAYPAY_URL = "https://login.paypay-bank.co.jp/lottery/co/numbers3jnb.csv"
RAKUTEN_URL = "https://takarakuji.rakuten.co.jp/backnumber/numbers3/"
UA = "Numbers3Web/0.1 (public lottery facts; two-official-source verification)"


def download(url: str, label: str) -> bytes:
    request = Request(url, headers={"User-Agent": UA, "Accept": "text/csv,text/html;q=0.9,*/*;q=0.1"})
    try:
        with urlopen(request, timeout=30) as response:
            if response.status != 200:
                raise RuntimeError(f"{label}: HTTP {response.status}")
            content = response.read(10 * 1024 * 1024 + 1)
    except HTTPError as exc:
        if exc.code in (403, 429):
            raise RuntimeError(f"{label}: HTTP {exc.code}; access restriction, stopping without retry") from exc
        raise RuntimeError(f"{label}: HTTP {exc.code}") from exc
    except URLError as exc:
        raise RuntimeError(f"{label}: connection failed: {exc.reason}") from exc
    if len(content) > 10 * 1024 * 1024:
        raise RuntimeError(f"{label}: response too large")
    return content


def parse_paypay(content: bytes) -> list[dict]:
    reader = csv.DictReader(io.StringIO(content.decode("cp932")))
    payout_header = "【ストレート】当せん金額（単位：円）"
    required = {"回号", "抽せん日", "抽せん数字", payout_header}
    if not required <= set(reader.fieldnames or []):
        raise RuntimeError("PayPay Bank CSV columns changed")
    rows = []
    for row in reader:
        draw_match = re.fullmatch(r"第([0-9]+)回", row["回号"].strip())
        number = row["抽せん数字"].strip()
        if not draw_match or not re.fullmatch(r"[0-9]{3}", number):
            raise RuntimeError("PayPay Bank CSV contains an invalid draw or number")
        rows.append({
            "draw": int(draw_match.group(1)),
            "date": row["抽せん日"].replace("/", "-").strip(),
            "number": number,
            "straightPayout": int(row[payout_header].replace(",", "")),
        })
    rows.sort(key=lambda item: item["draw"])
    for before, after in zip(rows, rows[1:]):
        if after["draw"] != before["draw"] + 1:
            raise RuntimeError(f"PayPay Bank CSV has a gap after draw {before['draw']}")
    if len(rows) < 30:
        raise RuntimeError("PayPay Bank CSV has too few rows")
    return rows


def parse_rakuten(content: bytes) -> list[dict]:
    text = content.decode("utf-8", "replace")
    text = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", " ", text, flags=re.I | re.S)
    text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    text = re.sub(r"\s+", " ", text)
    pattern = re.compile(
        r"回号\s*第([0-9]+)回\s*抽せん日\s*([0-9]{4})/([0-9]{2})/([0-9]{2})\s*当せん番号\s*([0-9]{3})(?![0-9])"
    )
    found = {
        int(draw): {"draw": int(draw), "date": f"{year}-{month}-{day}", "number": number}
        for draw, year, month, day, number in pattern.findall(text)
    }
    if not found:
        raise RuntimeError("Rakuten result table was not recognized")
    return [found[key] for key in sorted(found)]


def build() -> dict:
    paypay = parse_paypay(download(PAYPAY_URL, "PayPay Bank"))
    rakuten = parse_rakuten(download(RAKUTEN_URL, "Rakuten"))
    paypay_by_draw = {row["draw"]: row for row in paypay}
    rakuten_by_draw = {row["draw"]: row for row in rakuten}
    overlap = sorted(set(paypay_by_draw) & set(rakuten_by_draw))
    if not overlap:
        raise RuntimeError("The two official sources have no overlapping draws")
    for draw in overlap:
        paypay_fact = {key: paypay_by_draw[draw][key] for key in ("draw", "date", "number")}
        if paypay_fact != rakuten_by_draw[draw]:
            raise RuntimeError(f"Official sources disagree at draw {draw}; output unchanged")
    verified_latest = max(overlap)
    results = [row for row in paypay if row["draw"] <= verified_latest]
    if results[-1]["draw"] != verified_latest:
        raise RuntimeError("Verified latest draw is missing from output")
    return {
        "schema": 1,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "verifiedLatestDraw": verified_latest,
        "overlapChecked": len(overlap),
        "sources": [
            {"name": "PayPay銀行", "url": PAYPAY_URL},
            {"name": "楽天×宝くじ", "url": RAKUTEN_URL},
        ],
        "results": results,
    }


def main() -> None:
    payload = build()
    if OUTPUT.exists():
        current = json.loads(OUTPUT.read_text(encoding="utf-8"))
        if current.get("results") == payload["results"]:
            print(f"No new verified draw; latest is {payload['verifiedLatestDraw']}")
            return
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temporary = OUTPUT.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    temporary.replace(OUTPUT)
    print(f"Published {len(payload['results'])} rows through draw {payload['verifiedLatestDraw']}")


if __name__ == "__main__":
    main()
