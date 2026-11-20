--
-- PostgreSQL database cluster dump
--

-- Hand-written for the parser-kit sql-lite test suite in the shape
-- pg_dumpall / pg_dump 17.6 produce, to cover what the vendored sample
-- dump lacks: \restrict, roles, row-level security, policies, default
-- privileges, publications, identity columns, ALTER INDEX … ATTACH
-- PARTITION, SQL-standard function bodies and COPY data. It was not produced by a
-- server; every statement is meant to be valid PostgreSQL 17.

\restrict Rk3pQ8ZbW1nVx7LcT0RyJ5mGd2HsA9fEu4XoN6iKe7Vb2Ns9QdKxL4wPz1MhF6t

SET default_transaction_read_only = off;

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;

--
-- Roles
--

CREATE ROLE app_owner;
ALTER ROLE app_owner WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS PASSWORD 'SCRAM-SHA-256$4096:Y0ea1poJCyWCd+yPum+ZQQ==$h7BOWJYfmpnYU9QEagtbeT58Pku9IfWsqPsXwgzbHYs=:s+rNM0M7MbUlI1EDLJs+ei56p3ONXezfDdbGJoCFPAY=';
CREATE ROLE app_reader;
ALTER ROLE app_reader WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;
CREATE ROLE postgres;
ALTER ROLE postgres WITH SUPERUSER INHERIT CREATEROLE CREATEDB LOGIN REPLICATION BYPASSRLS;

--
-- User Configurations
--

--
-- User Config "app_owner"
--

ALTER ROLE app_owner SET search_path TO 'app', 'public';


--
-- Role memberships
--

GRANT app_reader TO app_owner WITH INHERIT TRUE GRANTED BY postgres;






\unrestrict Rk3pQ8ZbW1nVx7LcT0RyJ5mGd2HsA9fEu4XoN6iKe7Vb2Ns9QdKxL4wPz1MhF6t

--
-- Databases
--

--
-- Database "appdb" dump
--

--
-- PostgreSQL database dump
--

\restrict Rk3pQ8ZbW1nVx7LcT0RyJ5mGd2HsA9fEu4XoN6iKe7Vb2Ns9QdKxL4wPz1MhF6t

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: appdb; Type: DATABASE; Schema: -; Owner: app_owner
--

CREATE DATABASE appdb WITH TEMPLATE = template0 ENCODING = 'UTF8' LOCALE_PROVIDER = libc LOCALE = 'en_US.UTF-8';


ALTER DATABASE appdb OWNER TO app_owner;

\unrestrict Rk3pQ8ZbW1nVx7LcT0RyJ5mGd2HsA9fEu4XoN6iKe7Vb2Ns9QdKxL4wPz1MhF6t
\connect appdb
\restrict Rk3pQ8ZbW1nVx7LcT0RyJ5mGd2HsA9fEu4XoN6iKe7Vb2Ns9QdKxL4wPz1MhF6t

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: appdb; Type: DATABASE PROPERTIES; Schema: -; Owner: app_owner
--

ALTER DATABASE appdb SET search_path TO 'app', 'public';


--
-- Name: app; Type: SCHEMA; Schema: -; Owner: app_owner
--

CREATE SCHEMA app;


ALTER SCHEMA app OWNER TO app_owner;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner:
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: order_status; Type: TYPE; Schema: app; Owner: app_owner
--

CREATE TYPE app.order_status AS ENUM (
    'pending',
    'paid',
    'shipped'
);


ALTER TYPE app.order_status OWNER TO app_owner;

--
-- Name: shipping_band(numeric); Type: FUNCTION; Schema: app; Owner: app_owner
--

CREATE FUNCTION app.shipping_band(p_total numeric) RETURNS text
    LANGUAGE sql IMMUTABLE
    BEGIN ATOMIC
 SELECT
         CASE
             WHEN (shipping_band.p_total >= (100)::numeric) THEN 'free'::text
             WHEN (shipping_band.p_total >= (20)::numeric) THEN 'standard; tracked'::text
             ELSE 'standard'::text
         END AS "case";
END;


ALTER FUNCTION app.shipping_band(p_total numeric) OWNER TO app_owner;

--
-- Name: slugify(text); Type: FUNCTION; Schema: app; Owner: app_owner
--

CREATE FUNCTION app.slugify(t text) RETURNS text
    LANGUAGE sql IMMUTABLE
    RETURN lower(regexp_replace(t, '[^a-z0-9]+'::text, '-'::text, 'g'::text));


ALTER FUNCTION app.slugify(t text) OWNER TO app_owner;

--
-- Name: touch_updated_at(); Type: FUNCTION; Schema: app; Owner: app_owner
--

CREATE FUNCTION app.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now();
  RAISE DEBUG 'touched %; done', NEW.id;
  RETURN NEW;
END;
$$;


ALTER FUNCTION app.touch_updated_at() OWNER TO app_owner;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: customers; Type: TABLE; Schema: app; Owner: app_owner
--

CREATE TABLE app.customers (
    id integer NOT NULL,
    email text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customers_email_check CHECK ((email ~~ '%@%'::text))
);


ALTER TABLE app.customers OWNER TO app_owner;

--
-- Name: COLUMN customers.email; Type: COMMENT; Schema: app; Owner: app_owner
--

COMMENT ON COLUMN app.customers.email IS 'Login address; unique per customer';


--
-- Name: customers_id_seq; Type: SEQUENCE; Schema: app; Owner: app_owner
--

ALTER TABLE app.customers ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.customers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: events; Type: TABLE; Schema: app; Owner: app_owner
--

CREATE TABLE app.events (
    id bigint NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    payload jsonb
)
PARTITION BY RANGE (occurred_at);


ALTER TABLE app.events OWNER TO app_owner;

--
-- Name: events_2025; Type: TABLE; Schema: app; Owner: app_owner
--

CREATE TABLE app.events_2025 (
    id bigint NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    payload jsonb
);


ALTER TABLE app.events_2025 OWNER TO app_owner;

--
-- Name: gmail_customers; Type: VIEW; Schema: app; Owner: app_owner
--

CREATE VIEW app.gmail_customers AS
 SELECT id,
    email
   FROM app.customers
  WHERE ((email ~~* '%@gmail.com'::text) AND (name !~~ 'test%'::text));


ALTER TABLE app.gmail_customers OWNER TO app_owner;

--
-- Name: order_lines; Type: TABLE; Schema: app; Owner: app_owner
--

CREATE TABLE app.order_lines (
    order_id integer NOT NULL,
    line_no smallint NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    unit_price numeric(10,2) NOT NULL,
    CONSTRAINT order_lines_quantity_check CHECK ((quantity > 0))
);


ALTER TABLE app.order_lines OWNER TO app_owner;

--
-- Name: orders; Type: TABLE; Schema: app; Owner: app_owner
--

CREATE TABLE app.orders (
    id integer NOT NULL,
    customer_id integer NOT NULL,
    status app.order_status DEFAULT 'pending'::app.order_status NOT NULL,
    updated_at timestamp with time zone
);


ALTER TABLE app.orders OWNER TO app_owner;

--
-- Name: TABLE orders; Type: COMMENT; Schema: app; Owner: app_owner
--

COMMENT ON TABLE app.orders IS 'One row per checkout.
Lines live in order_lines.';


--
-- Name: archive_order(integer); Type: PROCEDURE; Schema: app; Owner: app_owner
--

CREATE PROCEDURE app.archive_order(IN p_order_id integer)
    LANGUAGE sql
    BEGIN ATOMIC
 UPDATE app.orders SET status = 'shipped'::app.order_status
   WHERE (orders.id = archive_order.p_order_id);
 DELETE FROM app.order_lines
   WHERE (order_lines.order_id = archive_order.p_order_id);
END;


ALTER PROCEDURE app.archive_order(IN p_order_id integer) OWNER TO app_owner;

--
-- Name: order_total(integer); Type: FUNCTION; Schema: app; Owner: app_owner
--

CREATE FUNCTION app.order_total(p_order_id integer) RETURNS numeric
    LANGUAGE sql STABLE
    BEGIN ATOMIC
 SELECT COALESCE(sum(((order_lines.quantity)::numeric * order_lines.unit_price)), (0)::numeric) AS "coalesce"
    FROM app.order_lines
   WHERE (order_lines.order_id = order_total.p_order_id);
END;


ALTER FUNCTION app.order_total(p_order_id integer) OWNER TO app_owner;

--
-- Name: orders_id_seq; Type: SEQUENCE; Schema: app; Owner: app_owner
--

CREATE SEQUENCE app.orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE app.orders_id_seq OWNER TO app_owner;

--
-- Name: orders_id_seq; Type: SEQUENCE OWNED BY; Schema: app; Owner: app_owner
--

ALTER SEQUENCE app.orders_id_seq OWNED BY app.orders.id;


--
-- Name: events_2025; Type: TABLE ATTACH; Schema: app; Owner: app_owner
--

ALTER TABLE ONLY app.events ATTACH PARTITION app.events_2025 FOR VALUES FROM ('2025-01-01 00:00:00+00') TO ('2026-01-01 00:00:00+00');


--
-- Name: orders id; Type: DEFAULT; Schema: app; Owner: app_owner
--

ALTER TABLE ONLY app.orders ALTER COLUMN id SET DEFAULT nextval('app.orders_id_seq'::regclass);


--
-- Data for Name: customers; Type: TABLE DATA; Schema: app; Owner: app_owner
--

COPY app.customers (id, email, name, created_at) FROM stdin;
1	ada@example.com	Ada	2025-01-02 03:04:05+00
2	bob@example.com	Bob's; "shop"	2025-02-03 04:05:06+00
3	carol@example.com	Carol	2025-03-04 05:06:07+00
\.


--
-- Data for Name: events_2025; Type: TABLE DATA; Schema: app; Owner: app_owner
--

COPY app.events_2025 (id, occurred_at, payload) FROM stdin;
\.


--
-- Data for Name: order_lines; Type: TABLE DATA; Schema: app; Owner: app_owner
--

COPY app.order_lines (order_id, line_no, quantity, unit_price) FROM stdin;
\.


--
-- Data for Name: orders; Type: TABLE DATA; Schema: app; Owner: app_owner
--

COPY app.orders (id, customer_id, status, updated_at) FROM stdin;
\.


--
-- Name: customers_id_seq; Type: SEQUENCE SET; Schema: app; Owner: app_owner
--

SELECT pg_catalog.setval('app.customers_id_seq', 3, true);


--
-- Name: orders_id_seq; Type: SEQUENCE SET; Schema: app; Owner: app_owner
--

SELECT pg_catalog.setval('app.orders_id_seq', 1, false);


--
-- Name: customers customers_email_key; Type: CONSTRAINT; Schema: app; Owner: app_owner
--

ALTER TABLE ONLY app.customers
    ADD CONSTRAINT customers_email_key UNIQUE (email);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: app; Owner: app_owner
--

ALTER TABLE ONLY app.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: order_lines order_lines_pkey; Type: CONSTRAINT; Schema: app; Owner: app_owner
--

ALTER TABLE ONLY app.order_lines
    ADD CONSTRAINT order_lines_pkey PRIMARY KEY (order_id, line_no);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: app; Owner: app_owner
--

ALTER TABLE ONLY app.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);


--
-- Name: events_occurred_at_idx; Type: INDEX; Schema: app; Owner: app_owner
--

CREATE INDEX events_occurred_at_idx ON ONLY app.events USING btree (occurred_at);


--
-- Name: events_2025_occurred_at_idx; Type: INDEX; Schema: app; Owner: app_owner
--

CREATE INDEX events_2025_occurred_at_idx ON app.events_2025 USING btree (occurred_at);


--
-- Name: orders_customer_id_idx; Type: INDEX; Schema: app; Owner: app_owner
--

CREATE INDEX orders_customer_id_idx ON app.orders USING btree (customer_id);


--
-- Name: events_2025_occurred_at_idx; Type: INDEX ATTACH; Schema: app; Owner:
--

ALTER INDEX app.events_occurred_at_idx ATTACH PARTITION app.events_2025_occurred_at_idx;


--
-- Name: orders orders_touch; Type: TRIGGER; Schema: app; Owner: app_owner
--

CREATE TRIGGER orders_touch BEFORE UPDATE ON app.orders FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: order_lines order_lines_order_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: app_owner
--

ALTER TABLE ONLY app.order_lines
    ADD CONSTRAINT order_lines_order_id_fkey FOREIGN KEY (order_id) REFERENCES app.orders(id) ON DELETE CASCADE;


--
-- Name: orders orders_customer_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: app_owner
--

ALTER TABLE ONLY app.orders
    ADD CONSTRAINT orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES app.customers(id);


--
-- Name: orders; Type: ROW SECURITY; Schema: app; Owner: app_owner
--

ALTER TABLE app.orders ENABLE ROW LEVEL SECURITY;

--
-- Name: orders orders_insert; Type: POLICY; Schema: app; Owner: app_owner
--

CREATE POLICY orders_insert ON app.orders AS RESTRICTIVE FOR INSERT TO app_reader WITH CHECK ((status = 'pending'::app.order_status));


--
-- Name: orders orders_owner; Type: POLICY; Schema: app; Owner: app_owner
--

CREATE POLICY orders_owner ON app.orders USING ((customer_id = (current_setting('app.customer_id'::text))::integer));


--
-- Name: POLICY orders_owner ON orders; Type: COMMENT; Schema: app; Owner: app_owner
--

COMMENT ON POLICY orders_owner ON app.orders IS 'Customers see only their own orders';


--
-- Name: app_pub; Type: PUBLICATION; Schema: -; Owner: app_owner
--

CREATE PUBLICATION app_pub WITH (publish = 'insert, update, delete, truncate');


ALTER PUBLICATION app_pub OWNER TO app_owner;

--
-- Name: app_schema_pub; Type: PUBLICATION; Schema: -; Owner: app_owner
--

CREATE PUBLICATION app_schema_pub WITH (publish = 'insert, update, delete, truncate');


ALTER PUBLICATION app_schema_pub OWNER TO app_owner;

--
-- Name: app_pub customers; Type: PUBLICATION TABLE; Schema: app; Owner:
--

ALTER PUBLICATION app_pub ADD TABLE ONLY app.customers (id, email) WHERE ((id > 0));


--
-- Name: app_pub orders; Type: PUBLICATION TABLE; Schema: app; Owner:
--

ALTER PUBLICATION app_pub ADD TABLE ONLY app.orders;


--
-- Name: app_schema_pub app; Type: PUBLICATION TABLES IN SCHEMA; Schema: app; Owner:
--

ALTER PUBLICATION app_schema_pub ADD TABLES IN SCHEMA app;


--
-- Name: SCHEMA app; Type: ACL; Schema: -; Owner: app_owner
--

GRANT USAGE ON SCHEMA app TO app_reader;


--
-- Name: PROCEDURE archive_order(IN p_order_id integer); Type: ACL; Schema: app; Owner: app_owner
--

GRANT ALL ON PROCEDURE app.archive_order(IN p_order_id integer) TO app_reader;


--
-- Name: FUNCTION order_total(p_order_id integer); Type: ACL; Schema: app; Owner: app_owner
--

REVOKE ALL ON FUNCTION app.order_total(p_order_id integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.order_total(p_order_id integer) TO app_reader;


--
-- Name: TABLE customers; Type: ACL; Schema: app; Owner: app_owner
--

GRANT SELECT ON TABLE app.customers TO app_reader;


--
-- Name: COLUMN orders.status; Type: ACL; Schema: app; Owner: app_owner
--

GRANT SELECT(status) ON TABLE app.orders TO app_reader;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: app; Owner: app_owner
--

ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA app GRANT SELECT ON TABLES TO app_reader;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: -; Owner: app_owner
--

ALTER DEFAULT PRIVILEGES FOR ROLE app_owner REVOKE ALL ON FUNCTIONS FROM PUBLIC;


--
-- PostgreSQL database dump complete
--

\unrestrict Rk3pQ8ZbW1nVx7LcT0RyJ5mGd2HsA9fEu4XoN6iKe7Vb2Ns9QdKxL4wPz1MhF6t

--
-- PostgreSQL database cluster dump complete
--

