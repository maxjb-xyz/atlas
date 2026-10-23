// The setup window: asks Atlas for a pairing code and shows it, then waits
// for the owner's yes (the Rust side polls and opens Atlas when paired).
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);
let link = "";

function error(text) {
  $("error").textContent = text;
  $("error").hidden = !text;
}

function ask() {
  $("ask").hidden = false;
  $("show").hidden = true;
}

invoke("last_address").then((u) => {
  if (u) $("url").value = u;
});

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  error("");
  const button = e.target.querySelector("button");
  button.disabled = true;
  button.textContent = "Asking Atlas…";
  try {
    const p = await invoke("start_pairing", { url: $("url").value });
    link = p.link;
    $("qr").innerHTML = p.qr;
    $("code").textContent = p.code;
    $("waiting").textContent = "Waiting for your yes…";
    $("ask").hidden = true;
    $("show").hidden = false;
  } catch (err) {
    error(String(err));
  } finally {
    button.disabled = false;
    button.textContent = "Get a pairing code";
  }
});

$("open").addEventListener("click", () => invoke("open_link", { url: link }).catch((e) => error(String(e))));
$("again").addEventListener("click", ask);

listen("paired", (e) => {
  $("waiting").textContent = `Paired as ${e.payload}. Opening Atlas…`;
});
listen("pair-expired", () => {
  ask();
  error("That code ran out or was turned down. Get a new one.");
});
listen("pair-error", (e) => error(String(e.payload)));
