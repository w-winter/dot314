export type GetModels = (provider: string) => any[];
const dynamicImport = (specifier: string) => import(specifier);

export async function resolveGetModels(
	root: any,
	loadCompat: () => Promise<any> = () => dynamicImport("@earendil-works/pi-ai/compat"),
): Promise<GetModels> {
	if (typeof root?.getModels === "function") return root.getModels;
	const compat = await loadCompat();
	if (typeof compat?.getModels !== "function") throw new Error("pi-ai getModels API is unavailable");
	return compat.getModels;
}