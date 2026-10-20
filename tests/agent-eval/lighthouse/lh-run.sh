#!/bin/bash
# usage: lh-run.sh <outdir>  — 4 pages x {mobile,desktop} x 3 runs
OUT=$1; mkdir -p "$OUT"
PAGES=("home|https://zuey.me/" "articles|https://zuey.me/articles" "article|https://zuey.me/articles/tui-dang-xay-nhung-cong-cu-de-nguoi-khac-khong-can-den-minh-nua" "pricing|https://zuey.me/pricing")
for p in "${PAGES[@]}"; do n=${p%%|*}; u=${p#*|}
  for f in mobile desktop; do for i in 1 2 3; do
    extra=""; [ $f = desktop ] && extra="--preset=desktop"
    npx -y lighthouse@13.5.0 "$u" $extra --only-categories=performance --output=json --output-path="$OUT/$n-$f-$i.json" --quiet --chrome-flags="--headless=new --no-sandbox" >/dev/null 2>&1 || echo "FAIL $n $f $i"
  done; done
done
echo DONE
