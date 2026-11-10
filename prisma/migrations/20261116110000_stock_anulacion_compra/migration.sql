-- Anular una compra devuelve el stock con un movimiento propio: se amplia la lista de tipos permitidos.
ALTER TABLE "movimientos_stock" DROP CONSTRAINT "movimientos_stock_tipo_check";
ALTER TABLE "movimientos_stock" ADD CONSTRAINT "movimientos_stock_tipo_check" CHECK ("tipo" IN ('INICIAL','PEDIDO','CANCELACION_PEDIDO','AJUSTE','IMPORTACION','VENTA','ANULACION_VENTA','DEVOLUCION_VENTA','COMPRA','ANULACION_COMPRA'));
