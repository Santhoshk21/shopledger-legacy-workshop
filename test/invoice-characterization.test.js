const assert = require('node:assert/strict');
const test = require('node:test');
const invoice = require('../lib/invoice');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');
const store = require('../lib/store');
const orderRoutes = require('../routes/orders');

test('a printable mixed-HSN invoice reconciles with the stored order', () => {
  const order = {
    id: 1001,
    coupon: 'SAVE10',
    subtotal: 3000,
    discount: 150,
    tax: 209,
    total: 3059,
    items: [
      { name: 'Rice', hsn: '1006', price: 1000, qty: 2 },
      { name: 'Ghee', hsn: '0405', price: 1000, qty: 1 }
    ]
  };
  const html = invoice.render(order);
  assert.match(html, /Invoice Total<\/td><td class="r">₹3059\.00/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
  assert.equal(reports.getGstReconciliation({ orders: [order] }).mismatchCount, 0);
});

test('checkout, printable invoice and reconciliation agree on a mixed-HSN sale', (t) => {
  const db = {
    products: [
      { id: 1, name: 'Rice', hsn: '1006', sku: 'RICE', price: 1000, stock: 10 },
      { id: 2, name: 'Ghee', hsn: '0405', sku: 'GHEE', price: 1000, stock: 10 }
    ],
    customers: [{ id: 1, name: 'Asha', creditLimit: 5000 }],
    orders: [],
    nextOrderId: 1001
  };
  t.mock.method(store, 'read', () => db);
  const write = t.mock.method(store, 'write', () => {});
  const { route } = orderRoutes.stack.find(({ route }) => route.path === '/orders' && route.methods.post);
  const response = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
    }
  };
  route.dispatch({
    method: 'POST',
    body: {
      items: [{ id: 1, qty: 2 }, { id: 2, qty: 1 }],
      coupon: ' save10 ',
      paymentMode: 'khata',
      customerId: 1
    }
  }, response, assert.ifError);

  assert.equal(response.statusCode, 201);
  const order = db.orders[0];
  assert.deepEqual(response.body, order);
  assert.equal(write.mock.callCount(), 1);
  assert.deepEqual(
    [order.coupon, order.subtotal, order.discount, order.tax, order.total],
    ['SAVE10', 3000, 150, 209, 3059]
  );
  assert.equal(db.customers[0].totalBilled, 3059);
  assert.deepEqual(pricing.computeTotals(order.items, order.coupon), {
    subtotal: 3000, discount: 150, taxable: 2850, tax: 209, cgst: 104.5, sgst: 104.5, total: 3059,
    lines: [
      { id: 1, name: 'Rice', hsn: '1006', gstPercent: 5, gross: 2000, discount: 100, taxable: 1900, tax: 95, net: 1995 },
      { id: 2, name: 'Ghee', hsn: '0405', gstPercent: 12, gross: 1000, discount: 50, taxable: 950, tax: 114, net: 1064 }
    ]
  });
  assert.deepEqual(invoice.computeInvoiceFigures(order), {
    subtotal: 3000, discount: 150, tax: 209, cgst: 104.5, sgst: 104.5, total: 3059,
    rows: [
      { name: 'Rice', sku: 'RICE', hsn: '1006', qty: 2, price: 1000, gstPercent: 5, line: 2000, lineTax: 95 },
      { name: 'Ghee', sku: 'GHEE', hsn: '0405', qty: 1, price: 1000, gstPercent: 12, line: 1000, lineTax: 114 }
    ]
  });

  const html = invoice.render(order);
  assert.match(html, /5%<\/td><td class="r">₹95\.00/);
  assert.match(html, /12%<\/td><td class="r">₹114\.00/);
  assert.match(html, /Total GST\)<\/td><td class="r">₹209\.00/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹3059\.00/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);

  assert.deepEqual(reports.getGstReconciliation(db), {
    totalChecked: 1,
    mismatchCount: 0,
    totalDelta: 0,
    rows: [{
      orderId: 1001, date: order.date, customer: 'Asha', coupon: 'SAVE10',
      ledgerSubtotal: 3000, ledgerDiscount: 150, ledgerTax: 209, ledgerTotal: 3059,
      invoiceDiscount: 150, invoiceTax: 209, invoiceTotal: 3059, delta: 0, matched: true
    }]
  });
});

test('an undiscounted 18% HSN sale agrees with the invoice and has no notice', () => {
  const items = [{ name: 'Tea', hsn: '0902', price: 100, qty: 2 }];
  const billed = pricing.computeTotals(items);
  const order = { ...billed, items };
  const figures = invoice.computeInvoiceFigures(order);
  assert.deepEqual([figures.tax, figures.cgst, figures.sgst, figures.total], [36, 18, 18, 236]);
  assert.equal(billed.tax, 36);
  assert.equal(billed.total, 236);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('the invoice handles explicit GST percentages, decimal rates and zero like checkout', () => {
  const items = [5, 0.05, 0].map((gstRate) => ({ price: 100, qty: 1, gstRate }));
  const billed = pricing.computeTotals(items);
  const figures = invoice.computeInvoiceFigures({ items });
  assert.deepEqual(billed.lines.map(({ gstPercent, tax }) => [gstPercent, tax]), [[5, 5], [5, 5], [0, 0]]);
  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [[5, 5], [5, 5], [0, 0]]);
  assert.equal(billed.total, 310);
  assert.equal(figures.total, 310);
});

test('a valid flat coupon reduces taxable amounts at checkout and on the invoice', () => {
  const items = [{ hsn: '0902', price: 300, qty: 1 }];
  const billed = pricing.computeTotals(items, 'FLAT50');
  const figures = invoice.computeInvoiceFigures({ items, coupon: 'FLAT50' });
  assert.deepEqual([billed.discount, billed.tax, billed.total], [50, 45, 295]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [50, 45, 295]);
});

test('the invoice rejects stored coupons below the minimum or marked inactive', () => {
  const cases = [
    { coupon: 'FLAT50', price: 20, expected: [0, 3.6, 23.6] },
    { coupon: 'DIWALI20', price: 1000, expected: [0, 180, 1180] }
  ];
  for (const { coupon, price, expected } of cases) {
    const items = [{ price, qty: 1 }];
    assert.equal(pricing.computeTotals(items, coupon).discount, 0, coupon);
    const figures = invoice.computeInvoiceFigures({ items, coupon });
    assert.deepEqual([figures.discount, figures.tax, figures.total], expected, coupon);
  }
});

test('invoice GST totals sum the rounded line GST amounts', () => {
  const items = [{ price: 0.03, qty: 1 }, { price: 0.03, qty: 1 }];
  const billed = pricing.computeTotals(items);
  const order = { ...billed, items };
  const figures = invoice.computeInvoiceFigures(order);
  assert.deepEqual(billed.lines.map((line) => line.tax), [0.01, 0.01]);
  assert.deepEqual([billed.tax, billed.cgst, billed.sgst, billed.total], [0.02, 0.01, 0.01, 0.08]);
  assert.deepEqual(figures.rows.map((row) => row.lineTax), [0.01, 0.01]);
  assert.deepEqual([figures.tax, figures.cgst, figures.sgst, figures.total], [0.02, 0.01, 0.01, 0.08]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('the reconciliation report and invoice notice both flag a tax-only mismatch', () => {
  const order = {
    id: 1, subtotal: 100, discount: 0, tax: 5, total: 118,
    items: [{ name: 'Tea', price: 100, qty: 1 }]
  };
  assert.match(invoice.render(order), /Invoice GST \(₹18\.00\) differs from Order Ledger recorded GST \(₹5\.00\)/);
  const result = reports.getGstReconciliation({ orders: [order] });
  assert.equal(result.totalChecked, 1);
  assert.equal(result.mismatchCount, 1);
  assert.equal(result.totalDelta, 0);
  const [row] = result.rows;
  assert.deepEqual([row.ledgerTax, row.invoiceTax, row.delta, row.matched], [5, 18, 0, false]);
});
