import json, os
p = os.path.join(os.path.dirname(__file__), "..", "js", "cities.json")
data = json.load(open(p, encoding="utf-8"))
assert len(data) > 10000, f"too few cities: {len(data)}"

def find(city, code):
    return [r for r in data if r["city"] == city and r["regionCode"] == code]

austin = find("Austin", "TX")
assert austin, "Austin, TX missing"
a = max(austin, key=lambda r: r["population"])
assert 29 < a["lat"] < 31 and -99 < a["lng"] < -96, a
assert a["tz"] == "America/Chicago", a

tokyo = [r for r in data if r["city"] == "Tokyo" and r["country"] == "JP"]
assert tokyo and tokyo[0]["tz"] == "Asia/Tokyo", "Tokyo missing/wrong tz"
print("verify_cities: OK", len(data), "cities")
