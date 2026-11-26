const test = require('node:test');
const assert = require('node:assert/strict');

const invoice = require('../lib/invoice');
const orders = require('../lib/orders');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');

function createBilledOrder(items, coupon = '') {
  const db = { nextOrderId: 1, orders: [] };
  const totals = pricing.computeTotals(items, coupon);
  return orders.add(db, {
    date: '01/03/2022',
    items,
    coupon,
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    total: totals.total
  });
}

const mixedRateItems = [
  { id: 1, name: 'Rice', sku: 'RICE', hsn: '1006', price: 1000, qty: 1 },
  { id: 2, name: 'Ghee', sku: 'GHEE', hsn: '0405', price: 1000, qty: 1 }
];

test('invoice preserves the billed amounts and GST breakdown when the coupon is no longer configured', () => {
  const order = { ...createBilledOrder(mixedRateItems, 'SAVE10'), coupon: 'RETIRED_PROMO' };
  const { rows, ...figures } = invoice.computeInvoiceFigures(order);

  assert.deepEqual(figures, {
    subtotal: 2000, discount: 150, tax: 157.25, cgst: 78.63, sgst: 78.62, total: 2007.25
  });
  assert.deepEqual(rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [
    [5, 46.25], [12, 111]
  ]);
});

test('CURRENT BEHAVIOUR: checkout allocates a capped coupon before applying each GST slab', () => {
  const { lines, ...totals } = pricing.computeTotals(mixedRateItems, 'SAVE10');

  assert.deepEqual(totals, {
    subtotal: 2000, discount: 150, taxable: 1850,
    tax: 157.25, cgst: 78.63, sgst: 78.62, total: 2007.25
  });
  assert.deepEqual(lines.map(({ gstPercent, discount, taxable, tax }) => ({
    gstPercent, discount, taxable, tax
  })), [
    { gstPercent: 5, discount: 75, taxable: 925, tax: 46.25 },
    { gstPercent: 12, discount: 75, taxable: 925, tax: 111 }
  ]);
});

test('invoice uses the billed HSN slabs without a coupon', () => {
  const order = createBilledOrder(mixedRateItems);
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 170);
  assert.equal(order.total, 2170);
  assert.equal(figures.tax, 170);
  assert.equal(figures.total, 2170);
  assert.deepEqual(figures.rows.map(({ hsn, gstPercent, lineTax }) => ({
    hsn, gstPercent, lineTax
  })), [
    { hsn: '1006', gstPercent: 5, lineTax: 50 },
    { hsn: '0405', gstPercent: 12, lineTax: 120 }
  ]);
});

test('invoice uses the billed coupon discount and post-discount GST', () => {
  const order = createBilledOrder(mixedRateItems, 'SAVE10');
  const { rows, ...figures } = invoice.computeInvoiceFigures(order);

  assert.deepEqual(figures, {
    subtotal: 2000, discount: 150, tax: 157.25, cgst: 78.63, sgst: 78.62, total: 2007.25
  });
});

test('the printable invoice shows the amounts billed at checkout', () => {
  const order = createBilledOrder(mixedRateItems, 'SAVE10');
  const html = invoice.render(order);

  assert.match(html, /5%<\/td><td class="r">₹46\.25/);
  assert.match(html, /12%<\/td><td class="r">₹111\.00/);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹157\.25/);
  assert.match(html, /Coupon Discount \(SAVE10\)<\/td><td\b[^>]*>-₹150\.00/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹2007\.25/);
  assert.doesNotMatch(html, /GST per item is unavailable/);
});

test('invoice uses checkout rounding for each GST line and the total', () => {
  const order = createBilledOrder([
    { id: 1, name: 'First item', price: 1.03, qty: 1 },
    { id: 2, name: 'Second item', price: 1.03, qty: 1 }
  ]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 0.38);
  assert.equal(order.total, 2.44);
  assert.deepEqual(figures.rows.map(({ lineTax }) => lineTax), [0.19, 0.19]);
  assert.equal(figures.tax, 0.38);
  assert.equal(figures.cgst, 0.19);
  assert.equal(figures.sgst, 0.19);
  assert.equal(figures.total, 2.44);
});

test('reconciliation matches both GST and total for a discounted order', () => {
  const order = createBilledOrder([{ id: 1, name: 'Tea', hsn: '0902', price: 1000, qty: 1 }], 'SAVE10');
  const { rows: [row], totalChecked, mismatchCount, totalDelta } = reports.getGstReconciliation({ orders: [order] });

  assert.equal(totalChecked, 1);
  assert.equal(mismatchCount, 0);
  assert.equal(totalDelta, 0);
  assert.equal(row.matched, true);
  assert.equal(row.ledgerTax, 162);
  assert.equal(row.invoiceTax, 162);
  assert.equal(row.ledgerTotal, 1062);
  assert.equal(row.invoiceTotal, 1062);
  assert.equal(row.delta, 0);
});

test('invoice preserves the billed totals when an older order cannot reproduce line GST', () => {
  const order = {
    ...createBilledOrder(mixedRateItems),
    tax: 150,
    total: 2150
  };
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(figures.tax, 150);
  assert.equal(figures.total, 2150);
  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [
    [null, null], [null, null]
  ]);

  const html = invoice.render(order);
  assert.match(html, /GST per item is unavailable for this order/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹2150\.00/);
});
