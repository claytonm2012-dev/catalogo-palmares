-- Completa campos que faltavam para o Admin controlar o catalogo de verdade:
-- imagem de categoria, logo/site de marca, agendamento de destaque/lancamento,
-- mensagem de WhatsApp customizada por produto, e status persistido do teste de QR Code.

alter table categories add column if not exists image text;

alter table brands add column if not exists logo text;
alter table brands add column if not exists website text;
alter table brands add column if not exists sort_order int not null default 0;

alter table products add column if not exists whatsapp_message text;
alter table products add column if not exists display_start_at date;
alter table products add column if not exists display_end_at date;
alter table products add column if not exists sort_order int not null default 0;
alter table products add column if not exists last_qr_test_status text;
alter table products add column if not exists last_qr_test_at timestamptz;

-- Documentos de produto ja tem name/url; garante nome amigavel de tipo (ex: "Manual", "Ficha tecnica").
alter table product_documents add column if not exists doc_type text;
