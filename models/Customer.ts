import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

const customerSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    phone: { type: String, trim: true, default: "", maxlength: 30, index: true },
    address: { type: String, trim: true, default: "", maxlength: 300 },
    /** Optional - needed on bills for VAT-registered business customers. */
    panNo: { type: String, trim: true, default: "", maxlength: 30 },
    notes: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

customerSchema.index({ name: "text", phone: "text" });

export type CustomerDoc = InferSchemaType<typeof customerSchema>;

export const Customer: Model<CustomerDoc> =
  (models.Customer as Model<CustomerDoc>) ??
  model<CustomerDoc>("Customer", customerSchema);
