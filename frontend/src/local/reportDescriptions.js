/**
 * One line per report, saying what it answers.
 *
 * Every card in a Report Center category used to say "Open report workspace" under its title, so
 * eight cards in a row carried the same sentence and a person choosing between "Payment Report" and
 * "Payment Mode Summary" had nothing to go on. Each line below is taken from the report's own
 * columns in App.jsx, so it describes what the report shows rather than what it might.
 *
 * `reportDescriptions.test.mjs` fails if a report listed in a category has no line here.
 */
import { ORDER_REPORT } from "./orderReporting.js";

export const REPORT_DESCRIPTIONS = Object.freeze({
  [ORDER_REPORT.BY_DATE]: "Orders taken each day, with their value.",
  [ORDER_REPORT.BY_PRODUCT]: "Which fruit was ordered, and how much of it.",
  [ORDER_REPORT.BY_CUSTOMER]: "Who ordered, how often, and for how much.",
  [ORDER_REPORT.FULFILMENT]: "Which orders went out, and which are still open.",
  salesHistory: "Every bill, with items, discounts, payment and status.",
  discountReport: "Discounts given, by product and lot, and what they cost in profit.",
  purchaseHistory: "Every purchase, with items, bill status and payments.",
  customerLedger: "One customer's bills and payments, with the running balance.",
  supplierLedger: "One supplier's bills and payments, with the running balance.",
  accountStatement: "Any account's entries, with the running balance.",
  paymentReport: "Money received and paid, with party, mode and reference.",
  paymentModeSummary: "Totals by cash, UPI, card and bank for each day.",
  receivableReport: "What each customer still owes.",
  payableReport: "What is still owed to each supplier.",
  returnHistory: "Every sale return, with refund, value and reason.",
  returnValue: "How much came back each day, in quantity and value.",
  returnReason: "Why customers returned fruit, and what it cost.",
  dailyWaste: "Waste recorded each day, by type, with its cost.",
  monthlyWaste: "Waste for each month, by type, with its cost.",
  productWiseWaste: "Waste for each product, in quantity and cost.",
  mostWastedProducts: "The products lost most often, largest first.",
  wasteCost: "What waste cost, at the price the stock was bought for.",
  stockInventory: "Stock on hand by product and lot, with its value and every adjustment.",
  profitLoss: "Sales, cost of the fruit sold, expenses and the profit left.",
  balanceSheet: "What the business owns and owes on one date.",
  cashBook: "Cash and bank in and out, day by day.",
  expenseReport: "Every expense, by category, mode and status.",
});

/** The line for a report id, or "" when there is none (the card then shows its title alone). */
export const describeReport = (reportId) => REPORT_DESCRIPTIONS[reportId] || "";
