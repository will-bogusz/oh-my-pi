import { afterEach, describe, expect, it, vi } from "bun:test";
import * as scrapers from "@oh-my-pi/pi-coding-agent/web/scrapers/types";
import { handleSecEdgar } from "@oh-my-pi/pi-coding-agent/web/scrapers/sec-edgar";

const COMPANY = {
	cik: "0001407583",
	name: "Example Filer Inc",
	tickers: ["EXF"],
	exchanges: ["Nasdaq"],
	addresses: { business: {}, mailing: {} },
	filings: {
		recent: {
			accessionNumber: ["0001493152-26-044876"],
			filingDate: ["2026-09-30"],
			reportDate: ["2026-09-30"],
			acceptanceDateTime: ["2026-09-30T16:00:00.000Z"],
			form: ["8-K"],
			primaryDocument: ["form8-k.htm"],
			primaryDocDescription: ["8-K"],
		},
	},
};

describe("SEC EDGAR handler on Archives URLs", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function stubSubmissions() {
		return vi.spyOn(scrapers, "loadPage").mockImplementation(async (url: string) => ({
			ok: true,
			status: 200,
			finalUrl: url,
			contentType: "application/json",
			content: JSON.stringify(COMPANY),
		}));
	}

	it("leaves a filing document to the page reader instead of answering with the company's filing list", async () => {
		const loadPage = stubSubmissions();

		for (const url of [
			"https://www.sec.gov/Archives/edgar/data/1407583/000149315226044876/form8-k.htm",
			"https://www.sec.gov/Archives/edgar/data/1407583/000149315226044876/",
		]) {
			expect(await handleSecEdgar(url, 5)).toBeNull();
		}
		expect(loadPage).not.toHaveBeenCalled();
	});

	it("still lists the filings of a company's Archives folder", async () => {
		const loadPage = stubSubmissions();

		const result = await handleSecEdgar("https://www.sec.gov/Archives/edgar/data/1407583/", 5);

		expect(result?.method).toBe("sec-edgar");
		expect(result?.content).toContain("Example Filer Inc");
		expect(loadPage).toHaveBeenCalledWith("https://data.sec.gov/submissions/CIK0001407583.json", expect.anything());
	});
});
