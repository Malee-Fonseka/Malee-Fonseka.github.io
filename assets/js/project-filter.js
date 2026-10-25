/*
  Area filter for the projects page.

  Every card carries data-area set to one of the area ids, and every filter
  button carries the same id ("all" shows every card):

    ai · data-engineering · software-systems · research · other

  This script counts the cards in each area, hides the cards outside the chosen
  one, and says how many are showing. The chosen area goes in the address as
  ?area=<id>, so a filtered view can be linked to and survives a reload.
  Nothing is stored in the browser.

  Without JavaScript none of this runs: the filter stays hidden and every card
  is shown.
*/
(() => {
  "use strict";

  const filters = document.querySelector(".filters");
  const status = document.querySelector(".filters-status");
  const grid = document.querySelector(".cards");
  if (!filters || !status || !grid) return;

  const buttons = [...filters.querySelectorAll(".filter")];
  const cards = [...grid.querySelectorAll(".card[data-area]")];
  const placeholder = grid.querySelector(".card--ghost:not(.card--empty)");
  const empty = grid.querySelector(".card--empty");
  const names = {};

  for (const button of buttons) {
    const area = button.dataset.area;
    names[area] = button.textContent.trim();   // read before the count is added
    button.querySelector(".filter__n").textContent =
      area === "all" ? cards.length : cards.filter((card) => card.dataset.area === area).length;
    button.addEventListener("click", () => select(area, true));
  }

  function select(area, clicked) {
    let shown = 0;
    for (const card of cards) {
      card.hidden = area !== "all" && card.dataset.area !== area;
      if (!card.hidden) shown++;
    }
    if (placeholder) placeholder.hidden = area !== "all";
    if (empty) empty.hidden = shown > 0;

    for (const button of buttons) button.setAttribute("aria-pressed", button.dataset.area === area);

    const count = document.createElement("b");
    count.textContent = shown;
    status.replaceChildren(count, ` project${shown === 1 ? "" : "s"} · ${area === "all" ? "all areas" : names[area]}`);

    if (!clicked) return;

    // Play the cards' entrance again, staggered from the first one now showing
    const visible = [...grid.children].filter((el) => !el.hidden);
    for (const el of visible) el.classList.remove("rise");
    void grid.offsetWidth;
    visible.forEach((el, i) => {
      el.style.setProperty("--i", i);
      el.classList.add("rise");
    });

    const url = new URL(location.href);
    if (area === "all") url.searchParams.delete("area");
    else url.searchParams.set("area", area);
    try {
      history.replaceState(null, "", url);
    } catch {
      // Pages opened straight from disk (file://) can't change their address
    }
  }

  const requested = new URLSearchParams(location.search).get("area");
  select(buttons.some((button) => button.dataset.area === requested) ? requested : "all", false);
  filters.hidden = false;
  status.hidden = false;
})();
