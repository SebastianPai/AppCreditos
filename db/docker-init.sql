-- Inicialización del contenedor PostgreSQL local (solo Docker).
-- La aplicación usa un usuario propietario sin privilegios de superusuario, como en Heroku.
create role capital_app login password 'capital_app';
create database capital_control owner capital_app;
