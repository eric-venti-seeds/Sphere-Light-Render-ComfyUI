"""Build js/cities.json from GeoNames (cities >= 15k population, worldwide).

Downloads are one-time and cached in tools/_cache/. Output is committed so end
users never fetch anything. Run: python tools/build_cities.py
"""
import io, json, os, urllib.request, zipfile, csv

BASE = "https://download.geonames.org/export/dump/"
CACHE = os.path.join(os.path.dirname(__file__), "_cache")
OUT = os.path.join(os.path.dirname(__file__), "..", "js", "cities.json")

def fetch(name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        print("downloading", name)
        urllib.request.urlretrieve(BASE + name, path)
    return path

def load_admin1():
    # admin1CodesASCII.txt: "US.TX\tTexas\tTexas\t<id>"
    m = {}
    with open(fetch("admin1CodesASCII.txt"), encoding="utf-8") as f:
        for row in csv.reader(f, delimiter="\t"):
            if len(row) >= 2:
                m[row[0]] = row[1]  # "US.TX" -> "Texas"
    return m

def load_countries():
    # countryInfo.txt: comment lines start with '#'; ISO code col 0, name col 4
    m = {}
    with open(fetch("countryInfo.txt"), encoding="utf-8") as f:
        for line in f:
            if line.startswith("#"):
                continue
            c = line.split("\t")
            if len(c) > 4 and c[0]:
                m[c[0]] = c[4]
    return m

def main():
    admin1 = load_admin1()
    countries = load_countries()
    zpath = fetch("cities15000.zip")
    with zipfile.ZipFile(zpath) as z:
        raw = z.read("cities15000.txt").decode("utf-8")

    out = []
    for row in csv.reader(io.StringIO(raw), delimiter="\t"):
        # cols: 1 name, 4 lat, 5 lng, 8 country, 10 admin1, 14 pop, 17 tz
        name, lat, lng = row[1], row[4], row[5]
        country, admin1code, pop, tz = row[8], row[10], row[14], row[17]
        out.append({
            "city": name,
            "regionCode": admin1code,
            "region": admin1.get(f"{country}.{admin1code}", ""),
            "country": country,
            "countryName": countries.get(country, ""),
            "lat": round(float(lat), 4),
            "lng": round(float(lng), 4),
            "tz": tz,
            "population": int(pop) if pop else 0,
        })

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {len(out)} cities to {os.path.normpath(OUT)}")

if __name__ == "__main__":
    main()
