// User-chosen names identify browser profiles without inspecting private account data.
const portInput = document.getElementById("port");
const labelInput = document.getElementById("label");
const codeInput = document.getElementById("code");
const status = document.getElementById("status");
let paired = false;
let connectedPort;
const save = document.getElementById("save");
save.disabled = true;
fetch(chrome.runtime.getURL("connection.json")).then(async response => {
	const defaults = await response.json();
	if (!response.ok || !Number.isInteger(defaults.port) || defaults.port < 1 || defaults.port > 65535)
		throw new Error("Invalid extension connection configuration; reinstall the extension.");
	return chrome.storage.local.get({ port: defaults.port, browserLabel: "", credential: "", connectionError: "" });
}).then(stored => {
	connectedPort = Number(stored.port);
	portInput.value = String(stored.port);
	labelInput.value = String(stored.browserLabel);
	paired = Boolean(stored.credential);
	status.textContent = stored.connectionError || (paired ? "Paired" : "Not paired yet");
	save.disabled = false;
}).catch(error => { status.textContent = error instanceof Error ? error.message : String(error); });
save.addEventListener("click", async () => {
	const port = Number(portInput.value);
	const browserLabel = labelInput.value.trim();
	const pairingCode = codeInput.value.trim();
	if (!Number.isInteger(port) || port < 1 || port > 65535) { status.textContent = "Enter a valid port"; return; }
	if (!browserLabel || browserLabel.length > 80) { status.textContent = "Choose a short browser name"; return; }
	if ((!paired || port !== connectedPort) && !pairingCode) { status.textContent = "Enter the pairing code from OMP"; return; }
	// A new code explicitly starts pairing; credentials belong to the selected endpoint.
	await chrome.storage.local.set({ port, browserLabel, pairingCode, connectionError: "", ...(pairingCode ? { credential: "" } : {}) });
	connectedPort = port;
	await chrome.runtime.sendMessage({ type: "reconnect" });
	codeInput.value = "";
	status.textContent = "Connecting…";
});
chrome.storage.onChanged.addListener(changes => {
	if (changes.credential?.newValue) { paired = true; status.textContent = "Paired"; }
	if (changes.connectionError?.newValue) status.textContent = changes.connectionError.newValue;
});
