/** Symbols use a stable English locale: $, €, £, CN¥, CA$, etc. */
export function formatMoney(currency: string, value: string, compact = false): string {
	const formatter = new Intl.NumberFormat("en-US", { style: "currency", currency });
	const symbol = formatter.formatToParts(0).find(part => part.type === "currency")?.value ?? currency;
	const prefix = symbol === currency ? `${currency} ` : symbol;
	const negative = value.startsWith("-");
	const unsigned = value.replace(/^-/, "");
	if (!compact) return `${negative ? "-" : ""}${prefix}${unsigned}`;

	// Work in decimal integers so large balances and rounding boundaries remain exact.
	const places = formatter.resolvedOptions().maximumFractionDigits ?? 2;
	const [whole, fraction = ""] = unsigned.split(".");
	const scale = 10n ** BigInt(places);
	const minor = BigInt(whole) * scale + BigInt(fraction.slice(0, places).padEnd(places, "0") || "0");
	const display = (units: bigint) => {
		const digits = units.toString().padStart(places + 1, "0");
		return `${prefix}${places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits}`;
	};
	if (minor === 0n && /[1-9]/.test(unsigned)) {
		return negative ? `>-${display(1n)}` : `<${display(1n)}`;
	}
	const rounded = minor + (Number(fraction[places] ?? "0") >= 5 ? 1n : 0n);
	return `${negative && rounded !== 0n ? "-" : ""}${display(rounded)}`;
}
