export type PaymentType = 'cod' | 'bank_transfer' | 'demo';
export type OrderStatus = 'pending' | 'paid' | 'cancelled';
export type PaymentStatus = 'pending' | 'paid';
export type FulfillmentStatus = 'queued' | 'ready' | 'failed' | 'cancelled';

export interface OrderItemView {
  id: string;
  productId: string;
  variantId: string;
  productName: string;
  variantName: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

export interface OrderView {
  id: string;
  status: OrderStatus;
  paymentType: PaymentType;
  paymentStatus: PaymentStatus;
  fulfillmentStatus: FulfillmentStatus;
  fulfillmentUpdatedAt: string;
  totalMinor: number;
  currency: 'PKR';
  transferReference: string | null;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
  cancelledAt: string | null;
  items: OrderItemView[];
}
